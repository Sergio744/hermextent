/** Injected in the provider tab's MAIN world before a request handler starts. */
export function installPageRequestCancellation(
  input: string | { requestId: string; requestUrl: string; additionalUrls?: string[] },
  rawRequestUrl?: string,
  rawAdditionalUrls: string[] = [],
) {
  const requestId = typeof input === 'string' ? input : input.requestId;
  const requestUrl = typeof input === 'string' ? rawRequestUrl ?? '' : input.requestUrl;
  const additionalUrls = typeof input === 'string' ? rawAdditionalUrls : input.additionalUrls ?? [];
  const origin = window.location.origin;
  const endpoints = [requestUrl, ...additionalUrls].flatMap(raw => {
    try {
      const parsed = new URL(raw, origin);
      const templateIndex = parsed.pathname.indexOf('{');
      const pathPrefix = templateIndex >= 0 ? parsed.pathname.slice(0, templateIndex) : parsed.pathname;
      const normalizedOrigin = parsed.origin.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
      return pathPrefix ? [{ origin: normalizedOrigin, pathPrefix }] : [];
    } catch { return []; }
  });
  if (!endpoints.length) return;

  const controller = new AbortController();
  const originalFetch = window.fetch;
  const originalWebSocket = window.WebSocket;
  const trackedSockets = new Set<WebSocket>();
  const matches = (target: URL) => {
    const normalizedOrigin = target.origin.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
    return endpoints.some(endpoint => target.protocol.startsWith('ws')
      ? normalizedOrigin === endpoint.origin && target.pathname.startsWith(endpoint.pathPrefix)
      : target.origin === endpoint.origin && target.pathname.startsWith(endpoint.pathPrefix));
  };
  const wrappedFetch: typeof window.fetch = function(input: RequestInfo | URL, init?: RequestInit) {
    let target: URL;
    try { target = new URL(input instanceof Request ? input.url : String(input), origin); }
    catch { return originalFetch.call(window, input, init); }
    if (!matches(target)) return originalFetch.call(window, input, init);
    return originalFetch.call(window, input, { ...init, signal: controller.signal });
  };
  class TrackedWebSocket extends originalWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      try {
        if (matches(new URL(url, origin))) {
          trackedSockets.add(this);
          this.addEventListener('close', () => trackedSockets.delete(this), { once: true });
        }
      } catch { /* leave unrelated sockets alone */ }
    }
  }
  const onMessage = (event: MessageEvent) => {
    if (event.source !== window || event.origin !== origin || event.data?.requestId !== requestId) return;
    if (event.data?.type === 'WEB_LLM_CANCEL') {
      controller.abort();
      for (const socket of trackedSockets) {
        try { socket.close(1000, 'Request cancelled'); } catch { /* socket is already closed */ }
      }
      trackedSockets.clear();
    }
    if (event.data?.type === 'WEB_LLM_CANCEL' || event.data?.type === 'WEB_LLM_CLEANUP') {
      window.removeEventListener('message', onMessage);
      if (window.fetch === wrappedFetch) window.fetch = originalFetch;
      if (window.WebSocket === TrackedWebSocket) window.WebSocket = originalWebSocket;
    }
  };
  window.addEventListener('message', onMessage);
  window.fetch = wrappedFetch;
  window.WebSocket = TrackedWebSocket;
}
