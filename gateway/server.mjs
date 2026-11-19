#!/usr/bin/env node
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BrowserSessions } from './browser-session.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimePath = path.join(ROOT, 'gateway', 'dist', 'provider-runtime.mjs');
let runtime;
try {
  await readFile(runtimePath);
  runtime = await import(`${pathToFileURL(runtimePath).href}?v=${Date.now()}`);
} catch {
  console.error('Bundle des fournisseurs absent. Lancez d’abord : npm run build:gateway');
  process.exit(1);
}

const { getAllPlugins, mainWorldFetch, createSseParser, createXmlTagParser, installPageRequestCancellation } = runtime;
const plugins = new Map(getAllPlugins().map(plugin => [plugin.definition.id, plugin]));
const providers = new Map([...plugins].map(([id, plugin]) => [id, {
  ...plugin,
  pageHandler: plugin.contentFetchHandler ?? mainWorldFetch,
}]));
const DEFAULT_PORT = Number(process.env.HERMEXTENT_GATEWAY_PORT || 20128);
const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_ACTIVE_REQUESTS = 8;
const activeRequests = new Set();
const home = path.resolve(process.env.HERMES_HOME || path.join(os.homedir(), '.hermes'));
const sessions = new BrowserSessions({ hermesHome: home, providers });
const bridgeToken = await loadOrCreateToken(path.join(home, '.env'));

async function loadOrCreateToken(envPath) {
  if (process.env.HERMEXTENT_GATEWAY_TOKEN || process.env.HERMEXTENT_BRIDGE_TOKEN) return process.env.HERMEXTENT_GATEWAY_TOKEN || process.env.HERMEXTENT_BRIDGE_TOKEN;
  let text = '';
  try { text = await readFile(envPath, 'utf8'); } catch { /* first run */ }
  const existing = text.split(/\r?\n/).map(line => line.match(/^\s*HERMEXTENT_BRIDGE_TOKEN\s*=\s*(.*?)\s*$/)?.[1]).map(value => value?.replace(/^(["'])(.*)\1$/, '$2')).find(value => value && value.length >= 32);
  if (existing) return existing;
  const token = randomBytes(48).toString('base64url');
  await mkdir(path.dirname(envPath), { recursive: true });
  const separator = text && !text.endsWith('\n') ? '\n' : '';
  await writeFile(envPath, `${text}${separator}\n# Local Hermes Browser gateway credential\nHERMEXTENT_BRIDGE_TOKEN=${token}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(envPath, 0o600).catch(() => undefined);
  return token;
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isLoopback(req) {
  const remote = req.socket.remoteAddress?.replace(/^::ffff:/, '');
  const host = String(req.headers.host || '').toLowerCase();
  return ['127.0.0.1', '::1', 'localhost'].includes(remote) && /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host);
}

function sendJson(res, status, value, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: { message, type: 'hermes_web_gateway_error' } });
}

function authorized(req) {
  const header = String(req.headers.authorization || '');
  return header.startsWith('Bearer ') && constantTimeEqual(header.slice(7), bridgeToken);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Requête trop volumineuse.'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Corps JSON invalide.'), { status: 400 }); }
}

function normalizeContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(part => part?.type === 'text').map(part => String(part.text || '')).join('');
  if (content == null) return '';
  return JSON.stringify(content);
}

function toolParts(messages) {
  return messages.map(message => {
    const role = String(message.role || 'user');
    if (role === 'tool') {
      const toolId = String(message.tool_call_id || '').replace(/["<>]/g, '');
      const name = String(message.name || '').replace(/["<>]/g, '');
      return { role: 'user', content: `<tool_response id="${toolId}" name="${name}">\n${normalizeContent(message.content)}\n</tool_response> Please continue based on this real tool result.` };
    }
    if (role === 'assistant' && Array.isArray(message.tool_calls)) {
      const calls = message.tool_calls.map(call => {
        const fn = call.function || {};
        let args = fn.arguments ?? {};
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
        const id = String(call.id || randomUUID()).replace(/["<>]/g, '');
        const name = String(fn.name || '').replace(/["<>]/g, '');
        return `<tool_call id="${id}" name="${name}">${JSON.stringify(args)}</tool_call>`;
      }).join('');
      return { role, content: `${normalizeContent(message.content)}${calls}` };
    }
    return { role: role === 'system' ? 'user' : role, content: normalizeContent(message.content) };
  });
}

function prepareProviderRequest(plugin, body, providerId, modelId) {
  const definition = plugin.definition;
  const strategy = plugin.toolStrategy ?? {
    buildToolPrompt: () => '',
    buildPrompt: ({ systemPrompt, messages }) => ({ systemPrompt, messages }),
  };
  const requestMessages = body.messages;
  const systemPrompt = requestMessages.filter(message => message.role === 'system').map(message => normalizeContent(message.content)).join('\n\n');
  const messages = toolParts(requestMessages.filter(message => message.role !== 'system'));
  const availableTools = definition.supportsTools && Array.isArray(body.tools) ? body.tools : [];
  const toolDefinitions = availableTools.map(tool => {
    const fn = tool.function || tool;
    return {
      name: String(fn.name || ''),
      description: String(fn.description || ''),
      parameters: fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : { type: 'object', properties: {} },
    };
  }).filter(tool => tool.name && !strategy.excludeTools?.has(tool.name));
  const toolPrompt = strategy.buildToolPrompt(toolDefinitions);
  const built = strategy.buildPrompt({ systemPrompt, toolPrompt, messages, conversationId: undefined });
  return { definition, built, toolDefinitions, modelId, providerId };
}

async function getCookiesForProvider(context, definition) {
  const domain = definition.cookieDomain.replace(/^\./, '').toLowerCase();
  const cookies = (await context.cookies()).filter(cookie => {
    const cookieDomain = cookie.domain.replace(/^\./, '').toLowerCase();
    return cookieDomain === domain || cookieDomain.endsWith(`.${domain}`);
  });
  return Object.fromEntries(cookies.map(cookie => [cookie.name, cookie.value]));
}

function sseWrite(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function openAiChunk(id, model, delta, finishReason = null) {
  return { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finishReason }] };
}

async function handleCompletion(req, res, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return sendError(res, 400, 'Le corps doit être un objet JSON.');
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 1000 || body.messages.some(message => !message || typeof message !== 'object')) {
    return sendError(res, 400, 'Liste messages invalide.');
  }
  if (body.tools != null && (!Array.isArray(body.tools) || body.tools.length > 256)) return sendError(res, 400, 'Liste tools invalide.');
  if (typeof body.model !== 'string' || !body.model.includes(':')) return sendError(res, 400, 'Le modèle attendu est provider-id:model-id, par exemple gemini-web:gemini-3-flash.');
  const separator = body.model.indexOf(':');
  const providerId = body.model.slice(0, separator);
  const modelId = body.model.slice(separator + 1);
  const plugin = providers.get(providerId);
  if (!plugin || !modelId || modelId.length > 160) return sendError(res, 404, 'Fournisseur/modèle non pris en charge.');
  if (activeRequests.size >= MAX_ACTIVE_REQUESTS) return sendError(res, 429, 'Trop de requêtes actives sur la passerelle locale.');

  const requestId = `chatcmpl-${randomUUID()}`;
  const abortController = new AbortController();
  const requestTimer = setTimeout(() => abortController.abort(new Error('Délai maximal de génération dépassé.')), 300_000);
  activeRequests.add(abortController);
  let started = false;
  let fullText = '';
  const toolCalls = [];
  const validToolNames = new Set((body.tools || []).map(tool => String((tool.function || tool).name || '')).filter(Boolean));
  const adapter = plugin.createStreamAdapter?.({ excludeTools: plugin.toolStrategy?.excludeTools }) ?? {
    processEvent: ({ delta }) => delta ? { feedText: delta } : null,
    flush: () => null,
    shouldAbort: () => false,
  };
  const sse = createSseParser();
  const xml = createXmlTagParser();
  const stream = Boolean(body.stream);
  const model = `${providerId}:${modelId}`;
  let finalError;

  const emitParsed = events => {
    for (const event of events) {
      if (event.type === 'text' && event.text) {
        fullText += event.text;
        if (stream) sseWrite(res, openAiChunk(requestId, model, { content: event.text }));
      } else if (event.type === 'tool_call') {
        if (!event.name || !validToolNames.has(event.name) || !event.arguments || typeof event.arguments !== 'object' || Array.isArray(event.arguments)) continue;
        const call = { id: event.id || randomUUID(), type: 'function', function: { name: event.name, arguments: event.arguments } };
        toolCalls.push(call);
        if (stream) sseWrite(res, openAiChunk(requestId, model, { tool_calls: [{ index: toolCalls.length - 1, ...call, function: { name: call.function.name, arguments: JSON.stringify(call.function.arguments) } }] }));
      }
    }
  };

  let providerAbortRequested = false;
  const processProviderEvent = event => {
    if (event.type === 'WEB_LLM_ERROR') throw new Error(String(event.error || 'Le fournisseur web a renvoyé une erreur.'));
    if (event.type !== 'WEB_LLM_CHUNK' || typeof event.chunk !== 'string') return;
    for (const item of sse.feed(event.chunk)) {
      if (item.data === '[DONE]') continue;
      let parsed;
      try { parsed = JSON.parse(item.data); } catch { continue; }
      const delta = plugin.definition.parseSseDelta(parsed);
      const adapted = adapter.processEvent({ parsed, delta });
      if (adapted?.feedText) emitParsed(xml.feed(adapted.feedText));
      if (!providerAbortRequested && adapter.shouldAbort?.()) {
        providerAbortRequested = true;
        const pending = adapter.flushPendingCalls?.();
        if (pending?.feedText) emitParsed(xml.feed(pending.feedText));
        abortController.abort();
      }
    }
  };

  let webRequest;
  try {
    const prepared = prepareProviderRequest(plugin, body, providerId, modelId);
    const uiContext = await sessions.ensureBrowser();
    const cookies = await getCookiesForProvider(uiContext, plugin.definition);
    webRequest = plugin.definition.buildRequest({
      messages: prepared.built.messages,
      systemPrompt: prepared.built.systemPrompt,
      credential: { providerId, cookies, token: cookies.token || cookies.access_token },
      thinkingLevel: ['thinking', 'high', 'medium'].includes(String(body.thinking_level ?? body.thinkingLevel ?? body.reasoning_effort ?? '').toLowerCase()) ? 'thinking' : 'fast',
    });
  } catch (error) {
    clearTimeout(requestTimer);
    activeRequests.delete(abortController);
    return sendError(res, 503, `Préparation de la session/requête impossible : ${String(error?.message || error)}`);
  }
  const requestPayload = {
    type: 'WEB_LLM_FETCH',
    requestId,
    url: webRequest.url,
    init: webRequest.init,
    setupRequest: webRequest.setupRequest,
    urlTemplate: webRequest.urlTemplate,
    binaryProtocol: webRequest.binaryProtocol,
    binaryEncodeBody: webRequest.binaryEncodeBody,
    providerMetadata: {},
  };

  if (stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    started = true;
  }
  res.on('close', () => {
    if (!res.writableEnded) abortController.abort();
  });

  try {
    const handlerEvents = sessions.run({ provider: plugin, handler: plugin.pageHandler, cancelHook: installPageRequestCancellation, request: requestPayload, signal: abortController.signal });
    for await (const event of handlerEvents) {
      if (event.type === 'WEB_LLM_DONE') break;
      if (event.type === '__handler_returned') break;
      processProviderEvent(event);
    }
    for (const item of sse.flush()) {
      if (item.data === '[DONE]') continue;
      let parsed;
      try { parsed = JSON.parse(item.data); } catch { continue; }
      const adapted = adapter.processEvent({ parsed, delta: plugin.definition.parseSseDelta(parsed) });
      if (adapted?.feedText) emitParsed(xml.feed(adapted.feedText));
    }
    const adapterTail = adapter.flush?.();
    if (adapterTail?.feedText) emitParsed(xml.feed(adapterTail.feedText));
    emitParsed(xml.flush());
    const finish = adapter.onFinish?.({ hasToolCalls: toolCalls.length > 0, fullText, thinkingContent: undefined });
    if (finish && 'error' in finish) throw new Error(finish.error);
    if (finish && 'promotedText' in finish && finish.promotedText) {
      fullText += finish.promotedText;
      if (stream) sseWrite(res, openAiChunk(requestId, model, { content: finish.promotedText }));
    }
    if (stream) {
      sseWrite(res, openAiChunk(requestId, model, {}, toolCalls.length ? 'tool_calls' : 'stop'));
      res.end('data: [DONE]\n\n');
    } else {
      const completion = {
        id: requestId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: fullText || null, ...(toolCalls.length ? { tool_calls: toolCalls.map(call => ({ ...call, function: { ...call.function, arguments: JSON.stringify(call.function.arguments) } })) } : {}) }, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
      sendJson(res, 200, completion);
    }
  } catch (error) {
    finalError = String(error?.message || error);
    if (started && !res.writableEnded) {
      sseWrite(res, { error: { message: finalError, type: 'provider_error' } });
      res.end('data: [DONE]\n\n');
    } else if (!res.headersSent) {
      sendError(res, 502, finalError);
    } else {
      res.end();
    }
  } finally {
    clearTimeout(requestTimer);
    activeRequests.delete(abortController);
  }
}

function localUiHtml() {
  const entries = [...providers.values()].map(plugin => {
    const d = plugin.definition;
    return `<article><div><strong>${escapeHtml(d.name)}</strong><small>${escapeHtml(d.id)}:${escapeHtml(d.defaultModelId)}</small></div><button data-provider="${escapeHtml(d.id)}">Ouvrir la session web</button><span class="status" id="s-${escapeHtml(d.id)}">Session non vérifiée</span></article>`;
  }).join('');
  return `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Hermes Web Gateway</title><style>
    :root{color-scheme:dark;font:15px system-ui;background:#0b1020;color:#e8edf8}body{max-width:850px;margin:48px auto;padding:0 20px}h1{font-size:28px;margin-bottom:8px}p{color:#aab6cc;line-height:1.5}.hint{padding:14px 16px;border:1px solid #293650;border-radius:12px;background:#111a2d;margin:22px 0}article{display:grid;grid-template-columns:1fr auto auto;gap:14px;align-items:center;padding:15px 0;border-bottom:1px solid #24304a}small{display:block;color:#96a7c4;margin-top:5px}button{border:0;border-radius:8px;padding:10px 14px;background:#6f8cff;color:#081126;font-weight:700;cursor:pointer}button:hover{background:#91a6ff}.status{font-size:13px;color:#9baac3}.ok{color:#63d6a0}@media(max-width:650px){article{grid-template-columns:1fr auto}.status{grid-column:1/-1}}
    </style><body><h1>Hermes Web Gateway</h1><p>Passerelle locale pour utiliser les sessions web connectées, sans extension Chrome et sans clé API fournisseur.</p><div class="hint"><strong>Connexion locale seulement.</strong> Le navigateur ouvert par le gateway utilise un profil séparé enregistré dans le dossier Hermes. Connecte-toi aux sites depuis cette fenêtre; les sessions sont conservées localement.</div><section>${entries}</section><script>
      async function refresh(){try{const r=await fetch('/api/providers');if(!r.ok)return;const items=await r.json();for(const p of items){const el=document.getElementById('s-'+p.id);if(el){el.textContent=p.authenticated?'Indice de cookie présent':'Aucun cookie indicateur détecté';el.className='status'+(p.authenticated?' ok':'')}}}catch{}}
      document.querySelectorAll('button[data-provider]').forEach(button=>button.addEventListener('click',async()=>{button.disabled=true;try{const response=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json','X-Hermes-Local-UI':'1'},body:JSON.stringify({providerId:button.dataset.provider})});const value=await response.json();if(!response.ok)alert(value.error?.message||'Impossible d’ouvrir la session')}catch(e){alert(String(e))}finally{button.disabled=false;refresh()}}));refresh();setInterval(refresh,5000);
    </script></body></html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

const server = createServer(async (req, res) => {
  if (!isLoopback(req)) return sendError(res, 403, 'Clients loopback uniquement.');
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  if (req.method === 'GET' && url.pathname === '/') {
    const body = Buffer.from(localUiHtml());
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff' });
    return res.end(body);
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, { ok: true, browserStarted: Boolean(sessions.context), providerCount: providers.size, activeRequests: activeRequests.size });
  }
  if (req.method === 'GET' && url.pathname === '/api/providers') {
    return sendJson(res, 200, await sessions.statuses());
  }
  if (req.method === 'POST' && url.pathname === '/api/login') {
    const origin = req.headers.origin;
    if (!['http://127.0.0.1:20128', `http://127.0.0.1:${DEFAULT_PORT}`, `http://localhost:${DEFAULT_PORT}`].includes(origin) || req.headers['x-hermes-local-ui'] !== '1') {
      return sendError(res, 403, 'Origine de l’interface locale refusée.');
    }
    try {
      const body = await readJson(req);
      const opened = await sessions.openLogin(String(body.providerId || ''));
      return sendJson(res, 200, { ok: true, providerId: opened.id });
    } catch (error) { return sendError(res, error.status || 400, String(error.message || error)); }
  }
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    if (!authorized(req)) return sendError(res, 401, 'Jeton de passerelle local invalide.');
    return sendJson(res, 200, { object: 'list', data: [...providers.values()].map(plugin => ({ id: `${plugin.definition.id}:${plugin.definition.defaultModelId}`, object: 'model', created: 0, owned_by: 'hermes-web-session' })) });
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    if (!authorized(req)) return sendError(res, 401, 'Jeton de passerelle local invalide.');
    try {
      const body = await readJson(req);
      return await handleCompletion(req, res, body);
    } catch (error) {
      if (!res.headersSent) return sendError(res, error.status || 500, String(error.message || error));
      if (!res.writableEnded) res.end();
    }
  }
  return sendError(res, 404, 'Route introuvable.');
});

server.requestTimeout = 0;
server.headersTimeout = 15_000;
server.listen(DEFAULT_PORT, HOST, () => {
  console.log(`Hermes Web Gateway écoute sur http://${HOST}:${DEFAULT_PORT}`);
  console.log(`Interface locale : http://${HOST}:${DEFAULT_PORT}/`);
  console.log('Ouvre l’interface, puis « Ouvrir la session web » pour chaque fournisseur souhaité.');
  console.log('Le jeton est conservé dans le profil Hermes; sa valeur n’est jamais affichée.');
});

async function shutdown() {
  for (const request of activeRequests) request.abort();
  await sessions.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
