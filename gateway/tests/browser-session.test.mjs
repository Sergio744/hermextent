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
