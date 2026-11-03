/** Injected in the provider tab's MAIN world before a request handler starts. */
export function installPageRequestCancellation(requestId: string, requestUrl: string) {
  const origin = window.location.origin;
  let pathPrefix = '';
  try {
    const parsed = new URL(requestUrl, origin);
    const templateIndex = parsed.pathname.indexOf('{');
    pathPrefix = templateIndex >= 0 ? parsed.pathname.slice(0, templateIndex) : parsed.pathname;
  } catch { return; }
  if (!pathPrefix) return;

  const controller = new AbortController();
  const originalFetch = window.fetch;
  const wrappedFetch: typeof window.fetch = function(input: RequestInfo | URL, init?: RequestInit) {
    let target: URL;
    try { target = new URL(input instanceof Request ? input.url : String(input), origin); }
    catch { return originalFetch.call(window, input, init); }
    if (target.origin !== origin || !target.pathname.startsWith(pathPrefix)) {
      return originalFetch.call(window, input, init);
    }
    return originalFetch.call(window, input, { ...init, signal: controller.signal });
  };
  const onMessage = (event: MessageEvent) => {
    if (event.source !== window || event.origin !== origin || event.data?.requestId !== requestId) return;
    if (event.data?.type === 'WEB_LLM_CANCEL') controller.abort();
    if (event.data?.type === 'WEB_LLM_CANCEL' || event.data?.type === 'WEB_LLM_CLEANUP') {
      window.removeEventListener('message', onMessage);
      if (window.fetch === wrappedFetch) window.fetch = originalFetch;
    }
  };
  window.addEventListener('message', onMessage);
  window.fetch = wrappedFetch;
}
