import test from 'node:test';
import assert from 'node:assert/strict';
import { getAllPlugins, createSseParser, createXmlTagParser, defaultToolStrategy, NativeWebRequestAssembler, installPageRequestCancellation, mergeRefreshedCredentials } from './.build/provider-test-api.mjs';

test('registre tous les 11 fournisseurs web attendus', () => {
  const plugins = getAllPlugins();
  assert.equal(plugins.length, 11);
  const ids = new Set(plugins.map(plugin => plugin.definition.id));
  for (const id of ['gemini-web', 'chatgpt-web', 'claude-web', 'deepseek-web', 'doubao-web', 'kimi-web', 'qwen-web', 'qwen-cn-web', 'glm-web', 'glm-intl-web', 'rakuten-web']) {
    assert.ok(ids.has(id), `fournisseur absent: ${id}`);
  }
  for (const plugin of plugins) {
    const definition = plugin.definition;
    assert.match(definition.loginUrl, /^https:\/\//);
    assert.ok(definition.cookieDomain.startsWith('.'));
    assert.ok(definition.defaultModelId);
    assert.equal(typeof definition.buildRequest, 'function');
    assert.equal(typeof definition.parseSseDelta, 'function');
  }
});

test('chaque plugin construit une requête HTTPS avec une session de test et expose son support', () => {
  for (const plugin of getAllPlugins()) {
    const definition = plugin.definition;
    const request = definition.buildRequest({
      messages: [{ role: 'user', content: 'hello' }],
      systemPrompt: 'system',
      credential: { providerId: definition.id, cookies: { token: 'test', access_token: 'test', sessionKey: 'test', ctoken: 'test', tongyi_sso_ticket: 'test' }, token: 'test' },
      thinkingLevel: 'fast',
    });
    assert.equal(new URL(request.url).protocol, 'https:');
    assert.ok(request.init);
    assert.equal(typeof definition.parseSseDelta, 'function');
    assert.equal(typeof plugin.toolStrategy?.buildPrompt, 'function');
  }
});

test('le rafraîchissement des sessions fusionne les tokens temporaires sans muter les cookies initiaux', () => {
  const original = { providerId: 'glm-web', cookies: { chatglm_refresh_token: 'refresh' }, token: undefined };
  const merged = mergeRefreshedCredentials(original, { chatglm_token: 'access', token: 'fallback' });
  assert.equal(merged.cookies.chatglm_token, 'access');
  assert.equal(merged.token, 'access');
  assert.equal(original.cookies.chatglm_token, undefined);
  assert.equal(original.token, undefined);
});

test('parser SSE conserve les événements fragmentés et les champs data multilignes', () => {
  const parser = createSseParser();
  assert.deepEqual(parser.feed('event: message\r\ndata: {"v":'), []);
  assert.deepEqual(parser.feed('1}\r\n\r\ndata: second\ndata: line\n\n'), [
    { event: 'message', data: '{"v":1}' },
    { event: undefined, data: 'second\nline' },
  ]);
  assert.deepEqual(parser.flush(), []);
});

test('parseur outil distingue le texte normal des appels structurés', () => {
  const parser = createXmlTagParser();
  const first = parser.feed('Avant <tool_call id="abc12345" name="read">{"path":');
  assert.deepEqual(first, [{ type: 'text', text: 'Avant ' }]);
  const second = parser.feed('"README.md"}</tool_call> après');
  assert.equal(second.length, 2);
  assert.deepEqual(second[0], { type: 'tool_call', id: 'abc12345', name: 'read', arguments: { path: 'README.md' } });
  assert.deepEqual(second[1], { type: 'text', text: ' après' });
});

test('Native Messaging réassemble les requêtes fournisseur segmentées et refuse les fragments invalides', () => {
  const request = { id: 'request-1', type: 'web_request', providerId: 'gemini-web', model: 'gemini-3-flash', request: { messages: [{ role: 'user', content: 'é'.repeat(200_000) }] } };
  const bytes = new TextEncoder().encode(JSON.stringify(request));
  const chunkSize = 100_000;
  const chunks = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const part = bytes.subarray(i, i + chunkSize);
    let binary = '';
    for (const byte of part) binary += String.fromCharCode(byte);
    chunks.push(btoa(binary));
  }
  const assembler = new NativeWebRequestAssembler();
  assert.deepEqual(assembler.accept({ type: 'web_request_start', id: request.id, providerId: request.providerId, model: request.model, totalBytes: bytes.length, totalChunks: chunks.length }), { kind: 'pending' });
  chunks.forEach((data, index) => assert.equal(assembler.accept({ type: 'web_request_chunk', id: request.id, index, data }).kind, 'pending'));
  const result = assembler.accept({ type: 'web_request_end', id: request.id });
  assert.equal(result.kind, 'request');
  assert.deepEqual(result.request, request);
  assert.equal(assembler.accept({ type: 'web_request_end', id: 'missing' }).kind, 'error');
});

test('annulation page interrompt le fetch fournisseur ciblé et restaure fetch', async () => {
  const originalWindow = globalThis.window;
  const listeners = new Set();
  const calls = [];
  const originalFetch = async (_input, init) => { calls.push(init); return new Response('ok'); };
  globalThis.window = {
    location: { origin: 'https://gemini.google.com' },
    fetch: originalFetch,
    addEventListener: (_type, callback) => listeners.add(callback),
    removeEventListener: (_type, callback) => listeners.delete(callback),
  };
  try {
    installPageRequestCancellation('cancel-me', 'https://gemini.google.com/api/generate');
    await window.fetch('/api/generate');
    assert.equal(calls[0].signal.aborted, false);
    await window.fetch('/other');
    assert.equal(calls[1], undefined);
    for (const listener of listeners) listener({ source: window, origin: window.location.origin, data: { type: 'WEB_LLM_CANCEL', requestId: 'cancel-me' } });
    assert.equal(calls[0].signal.aborted, true);
    assert.equal(window.fetch, originalFetch);
    assert.equal(listeners.size, 0);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('l’invite d’outils XML contient le nom, le schéma et la règle d’appel', () => {
  const prompt = defaultToolStrategy.buildToolPrompt([{ name: 'read_file', description: 'Lire un fichier', parameters: { type: 'object', properties: { path: { type: 'string' } } } }]);
  assert.match(prompt, /<tool_call id="unique_id" name="tool_name">/);
  assert.match(prompt, /read_file/);
  assert.match(prompt, /Lire un fichier/);
});
