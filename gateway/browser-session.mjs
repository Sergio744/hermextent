import path from 'node:path';
import os from 'node:os';
import { access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { chromium } from 'playwright-core';

const eventTypes = new Set(['WEB_LLM_CHUNK', 'WEB_LLM_DONE', 'WEB_LLM_ERROR', 'WEB_LLM_METADATA']);

class AsyncQueue {
  #items = [];
  #waiters = [];
  #closed = false;
  #error;

  push(value) {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value, done: false });
    else if (this.#items.length < 4096) this.#items.push(value);
    else this.fail(new Error('Le flux du navigateur a dépassé sa limite mémoire.'));
  }

  get closed() { return this.#closed; }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ done: true });
  }

  fail(error) {
    if (this.#closed) return;
    this.#error = error;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  async next() {
    if (this.#items.length) return { value: this.#items.shift(), done: false };
    if (this.#closed) {
      if (this.#error) throw this.#error;
      return { done: true };
    }
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  [Symbol.asyncIterator]() { return this; }
}

async function isFile(pathname) {
  if (!pathname) return false;
  try { await access(pathname, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return true; } catch { return false; }
}

async function findBrowserExecutable() {
  if (process.env.HERMES_BROWSER_EXECUTABLE) {
    if (!(await isFile(process.env.HERMES_BROWSER_EXECUTABLE))) {
      throw new Error('HERMES_BROWSER_EXECUTABLE ne pointe pas vers un exécutable accessible.');
    }
    return process.env.HERMES_BROWSER_EXECUTABLE;
  }
  const candidates = process.platform === 'win32'
    ? [
        path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  for (const candidate of candidates) if (await isFile(candidate)) return candidate;
  return undefined;
}

export class BrowserSessions {
  constructor({ hermesHome, providers }) {
    this.hermesHome = hermesHome;
    this.providers = providers;
    this.context = undefined;
    this.pages = new Map();
    this.active = new Map();
    this.locks = new Map();
    this.launchPromise = undefined;
  }

  async ensureBrowser() {
    if (this.context) return this.context;
    if (this.launchPromise) return this.launchPromise;
    this.launchPromise = (async () => {
      const userDataDir = path.join(this.hermesHome, 'browser-sessions');
      await mkdir(userDataDir, { recursive: true });
      const executablePath = await findBrowserExecutable();
      let context;
      try {
        context = await chromium.launchPersistentContext(userDataDir, {
          headless: false,
          ...(executablePath ? { executablePath } : { channel: process.platform === 'linux' ? 'chromium' : 'chrome' }),
          args: ['--no-first-run', '--no-default-browser-check'],
          viewport: null,
        });
      } catch (error) {
        this.launchPromise = undefined;
        const message = String(error?.message || error);
        if (/Executable doesn.t exist|is not found|no such file/i.test(message)) {
          throw new Error('Chrome ou Edge est introuvable. Installe Google Chrome ou Microsoft Edge, ou définis HERMES_BROWSER_EXECUTABLE avec le chemin complet du navigateur, puis relance npm run gateway.');
        }
        throw new Error(`Ouverture du navigateur dédié impossible : ${message.split('\n')[0]}`);
      }
      this.context = context;
      context.on('close', () => {
        this.context = undefined;
        this.pages.clear();
      });
      return context;
    })().finally(() => { this.launchPromise = undefined; });
    return this.launchPromise;
  }

  async #getPage(provider) {
    const context = await this.ensureBrowser();
    let page = this.pages.get(provider.id);
    if (!page || page.isClosed()) {
      page = await context.newPage();
      const pageState = { page, active: undefined };
      this.pages.set(provider.id, pageState);
      await page.exposeFunction('__hermesGatewayEvent', message => {
        const active = pageState.active;
        if (!active || message?.requestId !== active.requestId || !eventTypes.has(message?.type)) return;
        active.queue.push(message);
      });
      await page.addInitScript(() => {
        window.addEventListener('message', event => {
          if (event.source !== window || !event.data || typeof event.data !== 'object') return;
          const data = event.data;
          if (!['WEB_LLM_CHUNK', 'WEB_LLM_DONE', 'WEB_LLM_ERROR', 'WEB_LLM_METADATA'].includes(data.type)) return;
          const send = window.__hermesGatewayEvent;
          window.__hermesPendingGatewayEvents = (window.__hermesPendingGatewayEvents || Promise.resolve())
            .then(() => typeof send === 'function' ? send(data) : undefined)
            .catch(() => undefined);
        });
        window.__hermesPendingGatewayEvents = Promise.resolve();
      });
      page.on('close', () => {
        if (this.pages.get(provider.id) === pageState) this.pages.delete(provider.id);
        if (pageState.active) pageState.active.queue.fail(new Error('La fenêtre de session fournisseur a été fermée.'));
      });
      page.on('crash', () => {
        if (pageState.active) pageState.active.queue.fail(new Error('La page fournisseur a planté.'));
      });
    } else {
      page = page.page;
    }

    const expectedOrigin = new URL(provider.loginUrl).origin;
    if (page.url() === 'about:blank' || new URL(page.url()).origin !== expectedOrigin) {
      await page.goto(provider.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    }
    return { page, pageState: this.pages.get(provider.id) };
  }

  async openLogin(providerId) {
    const plugin = this.providers.get(providerId);
    if (!plugin) throw new Error(`Fournisseur inconnu : ${providerId}`);
    const { page } = await this.#getPage(plugin.definition);
    await page.bringToFront();
    console.log(`[session] Fenêtre ${plugin.definition.id} ouverte sur ${plugin.definition.loginUrl}`);
    return { id: providerId, url: plugin.definition.loginUrl };
  }

  async statuses() {
    const context = this.context;
    const results = [];
    for (const plugin of this.providers.values()) {
      const definition = plugin.definition;
      let authenticated = false;
      let pageOpen = false;
      if (context) {
        const state = this.pages.get(definition.id);
        pageOpen = Boolean(state && !state.page.isClosed());
        try {
          const cookies = await context.cookies();
          const domain = definition.cookieDomain.replace(/^\./, '').toLowerCase();
          authenticated = definition.sessionIndicators.some(name => cookies.some(cookie => {
            const cookieDomain = cookie.domain.replace(/^\./, '').toLowerCase();
            return cookie.name === name && Boolean(cookie.value) && (cookieDomain === domain || cookieDomain.endsWith(`.${domain}`));
          }));
        } catch { /* report unknown as logged out */ }
      }
      results.push({
        id: definition.id,
        name: definition.name,
        loginUrl: definition.loginUrl,
        authenticated,
        pageOpen,
        model: definition.defaultModelId,
        supportsTools: definition.supportsTools,
        supportsReasoning: definition.supportsReasoning,
      });
    }
    return results;
  }

  async *run({ provider, handler, cancelHook, request, signal }) {
    const providerId = provider.definition.id;
    const previous = this.locks.get(providerId) ?? Promise.resolve();
    let release;
    const lock = new Promise(resolve => { release = resolve; });
    const tail = previous.then(() => lock);
    this.locks.set(providerId, tail);
    await previous;
    let page;
    let pageState;
    let active;
    let cancel;
    let execution;
    const requestId = request.requestId;
    try {
      ({ page } = await this.#getPage(provider.definition));
      pageState = this.pages.get(providerId);
      const queue = new AsyncQueue();
      active = { requestId, queue };
      pageState.active = active;

      cancel = () => {
        void page.evaluate(id => window.postMessage({ type: 'WEB_LLM_CANCEL', requestId: id }, window.location.origin), requestId).catch(() => undefined);
        if (signal?.reason instanceof Error && signal.reason.message.includes('Délai maximal')) queue.fail(signal.reason);
        else queue.close();
      };
      if (signal?.aborted) {
        cancel();
        throw new Error('Requête annulée.');
      }
      signal?.addEventListener('abort', cancel, { once: true });
      if (cancelHook) {
        await page.evaluate(cancelHook, {
          requestId,
          requestUrl: request.url,
          additionalUrls: request.setupRequest?.url ? [request.setupRequest.url] : [],
        });
      }

      // Playwright serializes this self-contained provider handler into the page context;
      // no string eval or page CSP relaxation is needed.
      execution = page.evaluate(handler, request).then(async () => {
        await page.evaluate(() => window.__hermesPendingGatewayEvents);
        if (!queue.closed) queue.fail(new Error('Le handler fournisseur a terminé sans événement terminal.'));
      }).catch(error => queue.fail(new Error(`Exécution du fournisseur dans le navigateur impossible : ${String(error?.message ?? error)}`)));

      for await (const event of queue) {
        yield event;
        if (event.type === 'WEB_LLM_DONE' || event.type === 'WEB_LLM_ERROR') break;
      }
      if (!signal?.aborted) await execution;
    } finally {
      if (cancel) signal?.removeEventListener('abort', cancel);
      if (execution && page && !page.isClosed()) {
        let watchdog;
        const settled = await Promise.race([execution.then(() => true), new Promise(resolve => { watchdog = setTimeout(() => resolve(false), 2_000); })]);
        clearTimeout(watchdog);
        if (!settled) await page.goto(provider.definition.loginUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => undefined);
      }
      if (page && !page.isClosed()) {
        await page.evaluate(id => window.postMessage({ type: 'WEB_LLM_CLEANUP', requestId: id }, window.location.origin), requestId).catch(() => undefined);
      }
      if (pageState && pageState.active === active) pageState.active = undefined;
      release();
      if (this.locks.get(providerId) === tail) this.locks.delete(providerId);
    }
  }

  async close() {
    const context = this.context;
    this.context = undefined;
    if (context) await context.close().catch(() => undefined);
  }
}
