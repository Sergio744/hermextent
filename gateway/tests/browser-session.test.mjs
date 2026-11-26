import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSessions } from '../browser-session.mjs';


test('session status is heuristic and does not start Chrome just to report status', async () => {
  const providers = new Map([
    ['sample-web', { definition: {
      id: 'sample-web', name: 'Sample Web', loginUrl: 'https://example.com',
      cookieDomain: '.example.com', sessionIndicators: ['session'], defaultModelId: 'sample',
      supportsTools: false, supportsReasoning: false,
    } }],
  ]);
  const sessions = new BrowserSessions({ hermesHome: '/tmp/hermes-gateway-test', providers });
  const result = await sessions.statuses();
  assert.deepEqual(result, [{
    id: 'sample-web', name: 'Sample Web', loginUrl: 'https://example.com',
    authenticated: false, pageOpen: false, model: 'sample',
    supportsTools: false, supportsReasoning: false,
  }]);
  assert.equal(sessions.context, undefined);
});

test('profile modes map to the real Chrome/Edge directories and never write into them', async () => {
  const { resolveProfilePlan } = await import('../browser-session.mjs');
  const hermesHome = '/tmp/hermes-gateway-profile-test';

  const isolated = await resolveProfilePlan({ mode: 'isolated', hermesHome });
  assert.equal(isolated.userDataDir, '/tmp/hermes-gateway-profile-test/browser-sessions');
  assert.equal(isolated.isolated, true);
  assert.equal(isolated.profileDirectory, undefined);

  // An invalid profile name must fall back to Default instead of becoming a path.
  const traversal = await resolveProfilePlan({ mode: 'chrome', profile: '../../etc', hermesHome });
  assert.equal(traversal.profileDirectory, 'Default');
  assert.match(traversal.userDataDir, /browser-sessions[\\/]profile-backup[\\/]chrome$/);
  assert.equal(traversal.backupDir, traversal.userDataDir);
  assert.equal(traversal.profileDirectory, 'Default');

  const edge = await resolveProfilePlan({ mode: 'edge', profile: 'Profile 2', hermesHome });
  assert.equal(edge.profileDirectory, 'Profile 2');
  assert.equal(edge.browserLabel, 'Microsoft Edge');
  assert.equal(edge.isolated, false);

  await assert.rejects(() => resolveProfilePlan({ mode: 'firefox', hermesHome }), /Mode de profil inconnu/);
});

test('the profile plan copies the chosen profile out of the live browser directory', async () => {
  const { mkdtemp, mkdir, writeFile, readFile } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { resolveProfilePlan } = await import('../browser-session.mjs');

  // Simulate a Chrome user-data dir and point the resolver at it via LOCALAPPDATA.
  const root = await mkdtemp(path.join(os.tmpdir(), 'hermes-profile-copy-'));
  const userData = path.join(root, 'Google', 'Chrome', 'User Data');
  await mkdir(path.join(userData, 'Default'), { recursive: true });
  await writeFile(path.join(userData, 'Local State'), '{"profile":"state"}');
  await writeFile(path.join(userData, 'Default', 'Cookies'), 'sqlite-cookie-store');
  await writeFile(path.join(userData, 'Default', 'Preferences'), '{}');
  const previous = process.env.HERMES_CHROME_USER_DATA;
  process.env.HERMES_CHROME_USER_DATA = userData;
  try {
    const plan = await resolveProfilePlan({ mode: 'chrome', profile: 'Default', hermesHome: path.join(root, 'hermes') });
    assert.notEqual(plan.userDataDir, userData, 'the live Chrome directory must never be opened directly');
    assert.equal(await readFile(path.join(plan.userDataDir, 'Default', 'Cookies'), 'utf8'), 'sqlite-cookie-store');
    assert.equal(await readFile(path.join(plan.userDataDir, 'Local State'), 'utf8'), '{"profile":"state"}');
    // The source profile is left untouched.
    assert.equal(await readFile(path.join(userData, 'Default', 'Cookies'), 'utf8'), 'sqlite-cookie-store');
  } finally {
    if (previous === undefined) delete process.env.HERMES_CHROME_USER_DATA; else process.env.HERMES_CHROME_USER_DATA = previous;
  }
});

test('attach mode reports a usable debug endpoint and a clear failure otherwise', async () => {
  const { probeDebugEndpoint, BrowserSessions } = await import('../browser-session.mjs');

  const reachable = await probeDebugEndpoint('http://127.0.0.1:9222', async () => ({
    ok: true, json: async () => ({ Browser: 'Chrome/140.0.0.0', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/x' }),
  }));
  assert.equal(reachable.available, true);
  assert.equal(reachable.browser, 'Chrome/140.0.0.0');

  const missing = await probeDebugEndpoint('http://127.0.0.1:9222', async () => { throw new Error('connect ECONNREFUSED'); });
  assert.equal(missing.available, false);
  assert.match(missing.reason, /ECONNREFUSED/);

  const sessions = new BrowserSessions({ hermesHome: '/tmp/unused', providers: new Map(), profileMode: 'attach', attachUrl: 'http://127.0.0.1:9' });
  assert.deepEqual(sessions.describeProfile(), { mode: 'attach', profile: 'Default', browser: 'navigateur sur http://127.0.0.1:9', isolated: false });
  await assert.rejects(() => sessions.ensureBrowser(), /npm run chrome:debug/);
});

test('attach mode reuses the tab the user already has open on the provider site', async () => {
  const { BrowserSessions } = await import('../browser-session.mjs');
  const existing = {
    isClosed: () => false,
    url: () => 'https://chat.deepseek.com/a/chat/s/123',
    bringToFront: async () => undefined,
    evaluate: async () => undefined,
    exposeFunction: async () => undefined,
    addInitScript: async () => undefined,
    on: () => undefined,
  };
  let created = 0;
  const context = {
    pages: () => [existing],
    newPage: async () => { created += 1; return existing; },
    on: () => undefined,
  };
  const sessions = new BrowserSessions({ hermesHome: '/tmp/unused', providers: new Map(), profileMode: 'attach', attachUrl: 'http://127.0.0.1:9222' });
  sessions.ensureBrowser = async () => context;
  const provider = {
    id: 'deepseek-web',
    loginUrl: 'https://chat.deepseek.com/sign_in',
  };
  const { page } = await sessions._getPageForTest(provider);
  assert.equal(page, existing, 'the already-open provider tab must be reused');
  assert.equal(created, 0);
});

test('gateway-launched browsers hide the automation flags that block Google sign-in', async () => {
  const { STEALTH_LAUNCH_OPTIONS } = await import('../browser-session.mjs');
  assert.deepEqual(STEALTH_LAUNCH_OPTIONS.ignoreDefaultArgs, ['--enable-automation'],
    'Playwright adds --enable-automation, which Google identity rejects');
  assert.ok(STEALTH_LAUNCH_OPTIONS.args.includes('--disable-blink-features=AutomationControlled'));
  assert.ok(STEALTH_LAUNCH_OPTIONS.args.includes('--no-first-run'));
  assert.equal(STEALTH_LAUNCH_OPTIONS.args.some(arg => arg.includes('--enable-automation')), false);
});
