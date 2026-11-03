type Settings = { apiUrl: string; apiKey: string; routeMode: 'default' | 'web'; providerId: string; modelId: string; sessionId: string; sessionKey: string };
type ProviderStatus = { id: string; name: string; loginUrl: string; authenticated: boolean; model: string; supportsTools: boolean; supportsReasoning: boolean };
const defaults: Settings = { apiUrl: 'http://127.0.0.1:8642', apiKey: '', routeMode: 'default', providerId: 'gemini-web', modelId: '', sessionId: '', sessionKey: '' };
let settings: Settings = { ...defaults };
let connected = false;
let activeRequest = '';
let streamBuffer = '';
let currentAssistant: HTMLDivElement | undefined;
const providerModels = new Map<string, string>();

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const connection = $('#connection');
const settingsPanel = $('#settings');
const conversation = $('#conversation');
const welcome = $('#welcome');
const messages = $('#messages');
const promptInput = $('#prompt') as HTMLTextAreaElement;
const sendButton = $('#send') as HTMLButtonElement;
const providersElement = $('#providers');
const providerSelect = $('#provider-select') as HTMLSelectElement;
const apiUrlInput = $('#api-url') as HTMLInputElement;
const apiKeyInput = $('#api-key') as HTMLInputElement;
const routeSelect = $('#route-mode') as HTMLSelectElement;
const modelInput = $('#model-id') as HTMLInputElement;

function setConnection(ok: boolean, text?: string) {
  connected = ok;
  connection.className = `connection ${ok ? 'connected' : 'error'}`;
  connection.querySelector('span')!.textContent = text ?? (ok ? 'Compagnon local connecté' : 'Compagnon local indisponible');
}

function loadSettings() {
  void chrome.storage.local.get(['settings']).then(result => {
    settings = { ...defaults, ...((result.settings ?? {}) as Partial<Settings>) };
    apiUrlInput.value = settings.apiUrl;
    apiKeyInput.value = settings.apiKey;
    routeSelect.value = settings.routeMode;
    modelInput.value = settings.modelId;
    modelInput.placeholder = providerModels.get(settings.providerId) || 'par défaut du fournisseur';
    updateProviderPicker();
  });
}

function updateProviderPicker() {
  $('#provider-picker').classList.toggle('hidden', routeSelect.value !== 'web');
}

function showSettings(show: boolean) {
  settingsPanel.classList.toggle('hidden', !show);
  conversation.classList.toggle('hidden', show);
  $('#composer').closest('.composer-wrap')?.classList.toggle('hidden', show);
  if (show) void refreshProviders();
}

function renderProviders(list: ProviderStatus[]) {
  providersElement.replaceChildren();
  providerSelect.replaceChildren();
  providerModels.clear();
  for (const item of list) {
    providerModels.set(item.id, item.model);
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.name;
    providerSelect.append(option);

    const row = document.createElement('div');
    row.className = 'provider-row';
    const name = document.createElement('span');
    name.className = 'provider-name';
    name.textContent = item.name;
    const state = document.createElement('span');
    state.className = `provider-state ${item.authenticated ? 'ready' : ''}`;
    state.textContent = item.authenticated ? 'INDICE DE SESSION' : 'AUCUN INDICE';
    state.title = 'Détection heuristique par cookies; ce résultat ne vérifie ni l’accès au compte ni la compatibilité du fournisseur.';
    const actions = document.createElement('div');
    actions.className = 'provider-actions';
    const login = document.createElement('button');
    login.type = 'button';
    login.textContent = item.authenticated ? 'Ouvrir le site' : 'Se connecter';
    login.addEventListener('click', () => { void chrome.runtime.sendMessage({ type: 'open_provider_login', providerId: item.id }); });
    const choose = document.createElement('button');
    choose.type = 'button';
    choose.textContent = 'Utiliser';
    choose.addEventListener('click', () => {
      providerSelect.value = item.id;
      routeSelect.value = 'web';
      settings.providerId = item.id;
      settings.routeMode = 'web';
      updateProviderPicker();
      void saveSettings(false);
      showSettings(false);
    });
    actions.append(login, choose);
    row.append(name, state, actions);
    providersElement.append(row);
  }
  providerSelect.value = settings.providerId;
}

async function refreshProviders() {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'provider_status' }) as ProviderStatus[];
    renderProviders(Array.isArray(result) ? result : []);
  } catch {
    providersElement.innerHTML = '<p class="muted">Impossible de lire les sessions fournisseur. Vérifie les permissions de l’extension.</p>';
  }
}

async function saveSettings(close = false) {
  const apiUrl = apiUrlInput.value.trim().replace(/\/+$/, '');
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(apiUrl)) {
    apiUrlInput.setCustomValidity('Pour cette version, l’API Hermes doit être locale (127.0.0.1 ou localhost).');
    apiUrlInput.reportValidity();
    return;
  }
  apiUrlInput.setCustomValidity('');
  settings = {
    ...settings,
    apiUrl,
    apiKey: apiKeyInput.value.trim(),
    routeMode: routeSelect.value as Settings['routeMode'],
    providerId: providerSelect.value || settings.providerId,
    modelId: modelInput.value.trim(),
  };
  await chrome.storage.local.set({ settings });
  connection.querySelector('span')!.textContent = connected ? 'Configuration enregistrée' : 'Configuration enregistrée · compagnon déconnecté';
  if (close) showSettings(false);
}

function appendMessage(role: 'user' | 'assistant' | 'error', text = '') {
  welcome.classList.add('hidden');
  const node = document.createElement('div');
  node.className = `message ${role}`;
  if (role === 'assistant') {
    const label = document.createElement('div');
    label.className = 'message-label';
    label.textContent = 'HERMES';
    node.append(label, document.createTextNode(text));
  } else {
    node.textContent = text;
  }
  messages.append(node);
  conversation.scrollTop = conversation.scrollHeight;
  return node;
}

function assistantTextNode() {
  if (!currentAssistant) {
    currentAssistant = appendMessage('assistant');
  }
  return currentAssistant;
}

function appendAssistantText(text: string) {
  const node = assistantTextNode();
  node.append(document.createTextNode(text));
  conversation.scrollTop = conversation.scrollHeight;
}

function resetRequestState() {
  activeRequest = '';
  streamBuffer = '';
  currentAssistant = undefined;
  sendButton.disabled = false;
  sendButton.textContent = '↑';
  sendButton.setAttribute('aria-label', 'Envoyer');
  sendButton.title = 'Envoyer';
}

function cancelActiveRequest() {
  if (!activeRequest) return;
  const id = activeRequest;
  void chrome.runtime.sendMessage({ type: 'cancel_api_request', id });
  appendMessage('error', 'Génération annulée.');
  resetRequestState();
}

function processSseChunk(chunk: string) {
  streamBuffer += chunk;
  let boundary: number;
  while ((boundary = streamBuffer.indexOf('\n\n')) !== -1) {
    const block = streamBuffer.slice(0, boundary).replace(/\r/g, '');
    streamBuffer = streamBuffer.slice(boundary + 2);
    const dataLine = block.split('\n').find(line => line.startsWith('data:'));
    if (!dataLine) continue;
    const data = dataLine.slice(5).trimStart();
    if (data === '[DONE]') { resetRequestState(); continue; }
    try {
      const parsed = JSON.parse(data);
      if (parsed.error?.message) {
        appendMessage('error', String(parsed.error.message));
        resetRequestState();
        continue;
      }
      const choice = parsed.choices?.[0];
      const content = choice?.delta?.content ?? choice?.message?.content;
      if (typeof content === 'string' && content) appendAssistantText(content);
      if (choice?.finish_reason && !activeRequest) resetRequestState();
    } catch {
      // Ignore non-JSON SSE events (for example keep-alives) without breaking the stream.
    }
  }
}

async function sendPrompt(rawPrompt: string) {
  const text = rawPrompt.trim();
  if (!text || activeRequest) return;
  if (!connected) {
    appendMessage('error', 'Le compagnon local n’est pas connecté. Lance l’hôte Native Messaging et réessaie.');
    return;
  }
  await saveSettings(false);
  appendMessage('user', text);
  currentAssistant = undefined;
  sendButton.disabled = true;
  sendButton.textContent = '…';
  const url = `${settings.apiUrl}/v1/chat/completions`;
  const selectedModel = settings.modelId || providerModels.get(settings.providerId) || '';
  const model = settings.routeMode === 'web' && selectedModel
    ? `${settings.providerId}:${selectedModel}`
    : undefined;
  if (settings.routeMode === 'web' && !model) {
    appendMessage('error', 'Aucun modèle par défaut trouvé. Renseigne un identifiant de modèle du fournisseur dans les réglages.');
    resetRequestState();
    return;
  }
  const body: Record<string, unknown> = {
    messages: [{ role: 'user', content: text }],
    stream: true,
  };
  if (model) { body.model = model; body.provider = 'hermes-browser'; }
  const request = await chrome.runtime.sendMessage({
    type: 'api_request', url, method: 'POST', apiKey: settings.apiKey,
    sessionId: settings.sessionId, sessionKey: settings.sessionKey, body,
  }) as { ok: boolean; id?: string; error?: string };
  if (!request?.ok || !request.id) {
    appendMessage('error', request?.error ?? 'Impossible de transmettre la requête à Hermes.');
    resetRequestState();
    return;
  }
  activeRequest = request.id;
  sendButton.disabled = false;
  sendButton.textContent = '■';
  sendButton.setAttribute('aria-label', 'Annuler la génération');
  sendButton.title = 'Annuler la génération';
  $('#composer-hint').textContent = settings.routeMode === 'web'
    ? `Génération via ${settings.providerId.replace('-web', '')} · Les outils restent exécutés par Hermes.`
    : 'Hermes orchestre les outils sur ton compagnon local.';
}

chrome.runtime.onMessage.addListener((message: Record<string, unknown>) => {
  if (message.type === 'host_status') {
    setConnection(Boolean(message.connected), message.connected && !message.providerRelay ? 'Compagnon connecté · relais web non configuré' : undefined);
    return;
  }
  if (message.type !== 'host_event') return;
  const id = String(message.id ?? '');
  const eventType = String(message.eventType ?? '');
  if (!activeRequest || id !== activeRequest) return;
  if (eventType === 'api_headers') {
    let sessionChanged = false;
    if (typeof message.sessionId === 'string' && message.sessionId) {
      settings.sessionId = message.sessionId;
      sessionChanged = true;
    }
    if (typeof message.sessionKey === 'string' && message.sessionKey) {
      settings.sessionKey = message.sessionKey;
      sessionChanged = true;
    }
    if (sessionChanged) void chrome.storage.local.set({ settings });
    const status = Number(message.status ?? 200);
    if (status >= 400) appendMessage('error', `L’API Hermes a répondu HTTP ${status}. Vérifie sa configuration et la clé API.`);
    return;
  }
  if (eventType === 'api_chunk' && typeof message.chunk === 'string') {
    processSseChunk(message.chunk);
    return;
  }
  if (eventType === 'api_error') {
    appendMessage('error', String(message.error ?? 'Erreur de connexion à Hermes.'));
    resetRequestState();
    return;
  }
  if (eventType === 'api_result') resetRequestState();
});

$('#composer').addEventListener('submit', event => {
  event.preventDefault();
  if (activeRequest) { cancelActiveRequest(); return; }
  const text = promptInput.value;
  promptInput.value = '';
  promptInput.style.height = 'auto';
  void sendPrompt(text);
});
promptInput.addEventListener('input', () => {
  promptInput.style.height = 'auto';
  promptInput.style.height = `${Math.min(promptInput.scrollHeight, 140)}px`;
});
promptInput.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    $('#composer').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  }
});
$('#settings-toggle').addEventListener('click', () => showSettings(settingsPanel.classList.contains('hidden')));
$('#reconnect').addEventListener('click', () => { void chrome.runtime.sendMessage({ type: 'connect_host' }); setConnection(false, 'Connexion au compagnon…'); });
$('#save-settings').addEventListener('click', () => { void saveSettings(true); });
$('#refresh-providers').addEventListener('click', () => { void refreshProviders(); });
routeSelect.addEventListener('change', updateProviderPicker);
providerSelect.addEventListener('change', () => {
  settings.providerId = providerSelect.value;
  modelInput.placeholder = providerModels.get(settings.providerId) || 'identifiant de modèle requis';
});
$('#new-session').addEventListener('click', () => {
  if (activeRequest) cancelActiveRequest();
  settings.sessionId = '';
  settings.sessionKey = '';
  void chrome.storage.local.set({ settings });
  messages.replaceChildren();
  welcome.classList.remove('hidden');
  currentAssistant = undefined;
});
document.querySelectorAll<HTMLButtonElement>('[data-prompt]').forEach(button => button.addEventListener('click', () => {
  promptInput.value = button.dataset.prompt ?? '';
  void sendPrompt(promptInput.value);
  promptInput.value = '';
}));

loadSettings();
void chrome.runtime.sendMessage({ type: 'connect_host' });
void chrome.runtime.sendMessage({ type: 'provider_status' }).then((result: ProviderStatus[]) => { if (Array.isArray(result)) renderProviders(result); });
