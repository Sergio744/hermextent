import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('local router serves health/models, requires bearer auth, and exposes no session secrets', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'hermes-gateway-test-'));
  const home = path.join(temp, '.hermes');
  const token = 'test-local-router-token-never-log-this-0123456789';
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, '.env'), `OTHER_SETTING=kept\nHERMEXTENT_BRIDGE_TOKEN=${token}\n`);
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, 'gateway', 'server.mjs')], {
    cwd: root,
    env: { ...process.env, HERMES_HOME: home, HERMEXTENT_GATEWAY_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
    await rm(temp, { recursive: true, force: true });
  });

  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) { ready = true; break; }
    } catch { /* server is still starting */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(ready, true, `server failed to start: ${output}`);

  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.version, '0.3.0');
  assert.equal(health.providerCount, 11);

  const denied = await fetch(`${base}/v1/models`);
  assert.equal(denied.status, 401);

  const modelsResponse = await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(modelsResponse.status, 200);
  const models = await modelsResponse.json();
  assert.equal(models.data.length, 11);
  assert.ok(models.data.some(model => model.id === 'gemini-web:gemini-3-flash'));

  const providerStatus = await (await fetch(`${base}/api/providers`)).json();
  assert.equal(providerStatus.length, 11);
  assert.ok(providerStatus.every(provider => provider.authenticated === false));

  const invalidModel = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'unsupported:model', messages: [{ role: 'user', content: 'hello' }] }),
  });
  assert.equal(invalidModel.status, 404);
  assert.equal((await (await fetch(`${base}/health`)).json()).browserStarted, false, 'invalid models must not launch a browser');

  const sameOriginLogin = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId: 'unknown-provider' }),
  });
  assert.equal(sameOriginLogin.status, 400, 'the exact local Origin should reach provider validation without a custom marker header');
  assert.match((await sameOriginLogin.json()).error.message, /Fournisseur inconnu/);
  assert.equal((await (await fetch(`${base}/health`)).json()).browserStarted, false);

  const forgedLogin = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId: 'gemini-web' }),
  });
  assert.equal(forgedLogin.status, 403);
  assert.match((await forgedLogin.json()).error.message, /Origine refusée/);
  assert.equal((await (await fetch(`${base}/health`)).json()).browserStarted, false, 'a refused origin must never launch a browser');
  assert.equal(output.includes(token), false, 'local gateway credential must never appear in process logs');

  const persisted = await readFile(path.join(home, '.env'), 'utf8');
  assert.equal(persisted.includes(token), true);
  assert.equal(persisted.includes('OTHER_SETTING=kept'), true);
});
