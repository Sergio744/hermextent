import { getAllPlugins, getPlugin } from './web-providers/plugin-registry';
import { createSseParser } from './web-providers/sse-parser';
import { getSseStreamAdapter } from './web-providers/sse-stream-adapter';
import { createXmlTagParser } from './web-providers/xml-tag-parser';
import { defaultToolStrategy } from './web-providers/tool-strategy';
import type { WebProviderDefinition, WebProviderId } from './web-providers/types';
import { mainWorldFetch } from './web-providers/content-fetch-main';
import type { ContentFetchRequest } from './web-providers/content-fetch-main';
import { NativeWebRequestAssembler } from './native-framing';
import type { HostWebRequest } from './native-framing';
import { installPageRequestCancellation } from './page-cancellation';
import { mergeRefreshedCredentials } from './credential-refresh';

const HOST_NAME = 'com.hermextent.bridge';
const providers = new Map(getAllPlugins().map(plugin => [plugin.definition.id, plugin]));
let hostPort: chrome.runtime.Port | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
const requestAssembler = new NativeWebRequestAssembler();
const activeProviderRequests = new Map<string, { origin: string; tabId?: number; cancelled: boolean }>();
const providerRequestLocks = new Map<string, Promise<void>>();

const signalPageRequest = (id: string, action: 'WEB_LLM_CANCEL' | 'WEB_LLM_CLEANUP') => {
  const state = activeProviderRequests.get(id);
  if (state?.tabId === undefined) return;
  void chrome.scripting.executeScript({
    target: { tabId: state.tabId }, world: 'MAIN',
    func: (requestId: string, type: string) => window.postMessage({ type, requestId }, window.location.origin),
    args: [id, action],
  }).catch(() => undefined);
};

function cancelProviderRequest(id: string) {
  const state = activeProviderRequests.get(id);
  if (!state) return;
  state.cancelled = true;
  signalPageRequest(id, 'WEB_LLM_CANCEL');
  relayWaiters.delete(id);
}

async function acquireProviderLock(key: string): Promise<() => void> {
  const previous = providerRequestLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  const queued = previous.then(() => current);
  providerRequestLocks.set(key, queued);
  await previous;
  return () => {
    release();
    if (providerRequestLocks.get(key) === queued) providerRequestLocks.delete(key);
  };
}

const log = (level: 'info' | 'warn' | 'error', message: string, details?: unknown) => {
  console[level](`[Hermes Browser] ${message}`, details ?? '');
};

function connectNativeHost() {
  if (hostPort) return;
  try {
    const port = chrome.runtime.connectNative(HOST_NAME);
    hostPort = port;
    port.onMessage.addListener((message: Record<string, unknown>) => {
      const assembled = requestAssembler.accept(message);
      if (assembled?.kind === 'pending') return;
      if (assembled?.kind === 'error') {
        postHost({ type: 'provider_error', id: assembled.id, error: assembled.error });
        return;
      }
      if (assembled?.kind === 'request') {
        void handleProviderRequest(assembled.request);
        return;
      }
      if (message.type === 'provider_cancel') {
        if (typeof message.id === 'string') cancelProviderRequest(message.id);
        return;
      }
      if (message.type === 'web_request') {
        void handleProviderRequest(message as unknown as HostWebRequest);
        return;
      }
      if (message.type === 'host_ready') {
        chrome.runtime.sendMessage({ type: 'host_status', connected: true, providerRelay: Boolean(message.providerRelay) }).catch(() => undefined);
        return;
      }
      const id = typeof message.id === 'string' ? message.id : '';
      if (id) {
        chrome.runtime.sendMessage({ ...message, eventType: message.type, type: 'host_event' }).catch(() => undefined);
      }
    });
    port.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError?.message;
      if (error) log('warn', 'Le compagnon local est indisponible.', error);
      requestAssembler.clear();
      for (const id of activeProviderRequests.keys()) cancelProviderRequest(id);
      hostPort = undefined;
      chrome.runtime.sendMessage({ type: 'host_status', connected: false }).catch(() => undefined);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connectNativeHost, 3000);
    });
    port.postMessage({ type: 'hello', protocol: 1, extensionVersion: chrome.runtime.getManifest().version });
  } catch (error) {
    log('error', 'Impossible de démarrer le compagnon natif.', error);
    if (!reconnectTimer) reconnectTimer = setTimeout(() => { reconnectTimer = undefined; connectNativeHost(); }, 5000);
  }
}

chrome.runtime.onStartup.addListener(connectNativeHost);
chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  connectNativeHost();
});
connectNativeHost();

chrome.runtime.onMessage.addListener((message: Record<string, unknown>, _sender, sendResponse) => {
  if (message.type === 'connect_host') {
    connectNativeHost();
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === 'cancel_api_request') {
    const id = typeof message.id === 'string' ? message.id : '';
    if (hostPort && id) hostPort.postMessage({ type: 'api_cancel', id });
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === 'api_request') {
    if (!hostPort) {
      sendResponse({ ok: false, error: 'Le compagnon Hermes local n’est pas connecté.' });
      return false;
    }
    const id = crypto.randomUUID();
    const payload = { ...message, id, type: 'api_request' };
    hostPort.postMessage(payload);
    // The side panel receives chunks via host_event; this response acknowledges admission only.
    sendResponse({ ok: true, id });
    return false;
  }
  if (message.type === 'open_provider_login' && typeof message.providerId === 'string') {
    const plugin = providers.get(message.providerId as WebProviderId);
    if (!plugin) { sendResponse({ ok: false, error: 'Fournisseur inconnu.' }); return false; }
    void chrome.tabs.create({ url: plugin.definition.loginUrl, active: true })
      .then(() => sendResponse({ ok: true }))
      .catch(error => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message.type === 'provider_status') {
    void getProviderStatuses().then(sendResponse);
    return true;
  }
  return false;
});

type StreamOutput = { type: string; text?: string; id?: string; name?: string; arguments?: unknown };

function postHost(message: Record<string, unknown>) {
  if (!hostPort) throw new Error('Compagnon natif déconnecté.');
  hostPort.postMessage(message);
}

function openRelay(requestId: string, origin: string, tabId: number) {
  const relay = (id: string, allowedOrigin: string) => {
    const listener = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== allowedOrigin) return;
      const data = event.data;
      if (!data || data.requestId !== id) return;
      if (!['WEB_LLM_CHUNK', 'WEB_LLM_DONE', 'WEB_LLM_ERROR', 'WEB_LLM_METADATA'].includes(data.type)) return;
      chrome.runtime.sendMessage({ ...data, relayOrigin: allowedOrigin, relayTabId: tabId }).catch(() => undefined);
    };
    window.addEventListener('message', listener);
    setTimeout(() => window.removeEventListener('message', listener), 300_000);
  };
  return chrome.scripting.executeScript({
    target: { tabId }, world: 'ISOLATED', func: relay, args: [requestId, origin],
  });
}

const relayWaiters = new Map<string, (message: Record<string, unknown>) => void>();
chrome.runtime.onMessage.addListener((message: Record<string, unknown>) => {
  const id = typeof message.requestId === 'string' ? message.requestId : '';
  const deliver = id && relayWaiters.get(id);
  if (deliver && (message.type === 'WEB_LLM_CHUNK' || message.type === 'WEB_LLM_DONE' || message.type === 'WEB_LLM_ERROR' || message.type === 'WEB_LLM_METADATA')) {
    deliver(message);
  }
});

function waitForTab(tabId: number, timeout = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(onUpdated); reject(new Error('Le site du fournisseur met trop de temps à charger.')); }, timeout);
    const onUpdated = (id: number, change: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && change.status === 'complete') {
        clearTimeout(timer); chrome.tabs.onUpdated.removeListener(onUpdated); resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    void chrome.tabs.get(tabId).then(tab => { if (tab.status === 'complete') { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(onUpdated); resolve(); } }).catch(() => undefined);
  });
}

function toolParts(messages: Array<Record<string, unknown>>) {
  return messages.map(message => {
    const role = String(message.role ?? 'user');
    if (role === 'tool') {
      return { role: 'user', content: `<tool_response id="${String(message.tool_call_id ?? '')}" name="${String(message.name ?? '')}">\n${String(message.content ?? '')}\n</tool_response> Please continue based on this real tool result.` };
    }
    if (role === 'assistant' && Array.isArray(message.tool_calls)) {
      const calls = (message.tool_calls as Array<Record<string, any>>).map(call => {
        const fn = call.function ?? {};
        let args: unknown = fn.arguments ?? {};
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
        return `<tool_call id="${String(call.id ?? crypto.randomUUID())}" name="${String(fn.name ?? '')}">${JSON.stringify(args)}</tool_call>`;
      }).join('');
      return { role, content: `${String(message.content ?? '')}${calls}` };
    }
    let content = message.content;
    if (Array.isArray(content)) content = content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('');
    return { role: role === 'system' ? 'user' : role, content: typeof content === 'string' ? content : JSON.stringify(content ?? '') };
  });
}

async function getCredential(provider: WebProviderDefinition) {
  const cookies = await chrome.cookies.getAll({ domain: provider.cookieDomain });
  const cookieMap = Object.fromEntries(cookies.map(cookie => [cookie.name, cookie.value]));
  const stored = await chrome.storage.local.get(`web:${provider.id}`);
  const cached = stored[`web:${provider.id}`] as Record<string, unknown> | undefined;
  return { providerId: provider.id, cookies: cookieMap, token: cookieMap.token ?? cookieMap.access_token, ...(cached?.metadata ? { metadata: cached.metadata } : {}) };
}

async function handleProviderRequest(message: HostWebRequest) {
  const { id, request } = message;
  const providerId = message.providerId as WebProviderId;
  if (!providers.has(providerId)) { postHost({ type: 'provider_error', id, error: 'Identifiant fournisseur invalide.' }); return; }
  const plugin = getPlugin(providerId);
  if (!plugin) { postHost({ type: 'provider_error', id, error: 'Fournisseur web non pris en charge.' }); return; }
  const provider = plugin.definition;
  const providerOrigin = new URL(provider.loginUrl).origin;
  const requestState: { origin: string; tabId?: number; cancelled: boolean } = { origin: providerOrigin, cancelled: false };
  activeProviderRequests.set(id, requestState);
  let tabId: number | undefined;
  let releaseProviderLock: (() => void) | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  const adapter = plugin.createStreamAdapter?.({ excludeTools: plugin.toolStrategy?.excludeTools }) ?? getSseStreamAdapter(providerId);
  const sse = createSseParser();
  const xml = createXmlTagParser();
  const validToolNames = new Set((request.tools ?? []).map((tool: any) => String(tool.function?.name ?? tool.name ?? '')).filter(Boolean));
  let hasToolCalls = false;
  let fullText = '';
  const contentMessages = (request.messages ?? []).filter(m => m.role !== 'system');
  const systemPrompt = [...(request.messages ?? []).filter(m => m.role === 'system')].map(m => String(m.content ?? '')).join('\n\n');
  const simpleMessages = toolParts(contentMessages);
  const strategy = plugin.toolStrategy ?? defaultToolStrategy;
  const toolDefinitions = (provider.supportsTools ? request.tools ?? [] : []).map((tool: any) => {
    const fn = tool.function ?? tool;
    return { name: String(fn.name ?? ''), description: String(fn.description ?? ''), parameters: (fn.parameters ?? { type: 'object', properties: {} }) as Record<string, unknown> };
  }).filter(tool => tool.name && !strategy.excludeTools?.has(tool.name));
  const toolPrompt = strategy.buildToolPrompt(toolDefinitions);
  const builtPrompt = strategy.buildPrompt({ systemPrompt, toolPrompt, messages: simpleMessages, conversationId: undefined });
  try {
  let requestPayload: ContentFetchRequest;
  const onEvent = (event: Record<string, unknown>) => {
    if (done) return;
    if (event.type === 'WEB_LLM_ERROR') {
      done = true; if (timeout) clearTimeout(timeout); relayWaiters.delete(id);
      postHost({ type: 'provider_error', id, error: String(event.error ?? 'Le fournisseur a renvoyé une erreur.') }); return;
    }
    if (event.type === 'WEB_LLM_DONE') {
      done = true; if (timeout) clearTimeout(timeout); relayWaiters.delete(id);
      for (const parsed of sse.flush()) processSse(parsed);
      const adapterTail = adapter.flush();
      if (adapterTail) emitParsed(xml.feed(adapterTail.feedText));
      emitParsed(xml.flush());
      if (adapter.onFinish) {
        const result = adapter.onFinish({ hasToolCalls, fullText, thinkingContent: undefined });
        if (result && 'error' in result) { postHost({ type: 'provider_error', id, error: result.error }); return; }
        if (result && 'promotedText' in result && result.promotedText) {
          const promoted = result.promotedText;
          postHost({ type: 'provider_delta', id, content: promoted });
        }
      }
      postHost({ type: 'provider_done', id, finishReason: hasToolCalls ? 'tool_calls' : 'stop' });
      return;
    }
    if (event.type === 'WEB_LLM_CHUNK' && typeof event.chunk === 'string') {
      for (const parsed of sse.feed(event.chunk)) processSse(parsed);
    }
  };
  const processSse = (event: { data: string }) => {
    if (event.data === '[DONE]') return;
    let parsed: unknown;
    try { parsed = JSON.parse(event.data); } catch { return; }
    const delta = provider.parseSseDelta(parsed);
    const result = adapter.processEvent({ parsed, delta });
    if (result) emitParsed(xml.feed(result.feedText));
  };
  const emitParsed = (events: StreamOutput[]) => {
    for (const event of events) {
      if (event.type === 'text') {
        if (event.text) { fullText += event.text; postHost({ type: 'provider_delta', id, content: event.text }); }
      } else if (event.type === 'tool_call') {
        const args = event.arguments;
        if (!event.name || !validToolNames.has(event.name)) {
          log('warn', 'Le modèle a tenté un outil qui n’est pas déclaré à Hermes.', event.name);
          continue;
        }
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
          log('warn', 'Appel d’outil ignoré : les arguments ne sont pas un objet JSON.', event.name);
          continue;
        }
        hasToolCalls = true;
        postHost({ type: 'provider_tool_call', id, toolCall: { id: event.id ?? crypto.randomUUID(), name: event.name, arguments: args } });
      }
    }
  };
  const listener = (event: Record<string, unknown>) => {
    if (event.requestId !== id || event.relayOrigin !== providerOrigin || event.relayTabId !== tabId) return;
    onEvent(event);
  };
  relayWaiters.set(id, listener);
  timeout = setTimeout(() => {
    if (done) return;
    done = true;
    cancelProviderRequest(id);
    postHost({ type: 'provider_error', id, error: 'Délai maximal de génération dépassé.' });
  }, 300_000);

    releaseProviderLock = await acquireProviderLock(providerOrigin);
    if (requestState.cancelled) return;
    const existing = await chrome.tabs.query({ url: `${providerOrigin}/*` });
    if (requestState.cancelled) return;
    if (existing[0]?.id !== undefined) tabId = existing[0].id;
    else {
      const created = await chrome.tabs.create({ url: provider.loginUrl, active: false });
      if (created.id === undefined) throw new Error('Impossible de créer un onglet fournisseur.');
      tabId = created.id;
      await waitForTab(tabId);
    }
    requestState.tabId = tabId;
    if (requestState.cancelled) return;
    let credentials = await getCredential(provider);
    if (requestState.cancelled) return;
    if (provider.refreshAuth) {
      try {
        const refreshed = await provider.refreshAuth({ tabId, cookies: credentials.cookies });
        credentials = mergeRefreshedCredentials(credentials, refreshed);
      } catch (error) {
        log('warn', 'Actualisation de session fournisseur indisponible; la requête continue avec la session existante.', { providerId, error: String(error) });
      }
    }
    if (requestState.cancelled) return;
    const webRequest = provider.buildRequest({
      messages: builtPrompt.messages,
      systemPrompt: builtPrompt.systemPrompt,
      credential: credentials,
      thinkingLevel: 'fast',
    });
    requestPayload = {
      type: 'WEB_LLM_FETCH', requestId: id, url: webRequest.url, init: webRequest.init,
      setupRequest: webRequest.setupRequest, urlTemplate: webRequest.urlTemplate,
      binaryProtocol: webRequest.binaryProtocol, binaryEncodeBody: webRequest.binaryEncodeBody,
      providerMetadata: (credentials as any).metadata,
    };
    await openRelay(id, providerOrigin, tabId);
    await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: installPageRequestCancellation, args: [id, requestPayload.url] });
    if (requestState.cancelled) { signalPageRequest(id, 'WEB_LLM_CANCEL'); return; }
    const fetchHandler = plugin.contentFetchHandler ?? mainWorldFetch;
    await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: fetchHandler, args: [requestPayload] });
  } catch (error) {
    done = true;
    if (!requestState.cancelled) postHost({ type: 'provider_error', id, error: error instanceof Error ? error.message : String(error) });
  } finally {
    if (timeout) clearTimeout(timeout);
    relayWaiters.delete(id);
    signalPageRequest(id, 'WEB_LLM_CLEANUP');
    activeProviderRequests.delete(id);
    releaseProviderLock?.();
  }
}

async function getProviderStatuses() {
  const result = [];
  for (const { definition } of getAllPlugins()) {
    const cookies = await chrome.cookies.getAll({ domain: definition.cookieDomain }).catch(() => []);
    const authenticated = definition.sessionIndicators.some(name => cookies.some(cookie => cookie.name === name && !!cookie.value));
    result.push({ id: definition.id, name: definition.name, loginUrl: definition.loginUrl, authenticated, model: definition.defaultModelId, supportsTools: definition.supportsTools, supportsReasoning: definition.supportsReasoning });
  }
  return result;
}
