#!/usr/bin/env node
// One-shot verification of a running gateway: same request Hermes makes, using the exact
// bearer token the installer stored in the Hermes .env. The token is never printed.
import path from 'node:path';
import os from 'node:os';
import { readFile } from 'node:fs/promises';

const home = path.resolve(process.env.HERMES_HOME || path.join(os.homedir(), '.hermes'));
const base = process.env.HERMEXTENT_GATEWAY_URL || 'http://127.0.0.1:20128';
const requested = process.argv[2];
const prompt = process.argv[3] || 'Réponds uniquement par: OK';

async function readToken() {
  if (process.env.HERMEXTENT_BRIDGE_TOKEN) return process.env.HERMEXTENT_BRIDGE_TOKEN;
  const text = await readFile(path.join(home, '.env'), 'utf8').catch(() => '');
  const value = text.split(/\r?\n/)
    .map(line => line.match(/^\s*HERMEXTENT_BRIDGE_TOKEN\s*=\s*(.*?)\s*$/)?.[1])
    .map(raw => raw?.replace(/^(["'])(.*)\1$/, '$2'))
    .find(candidate => candidate && candidate.length >= 32);
  if (!value) throw new Error(`Aucun jeton trouvé dans ${path.join(home, '.env')}. Lance d’abord gateway/install.py.`);
  return value;
}

const token = await readToken();
const health = await fetch(`${base}/health`).then(response => response.json()).catch(() => undefined);
if (!health?.ok) {
  console.error(`Le gateway ne répond pas sur ${base}. Lance « npm run gateway » dans un autre terminal.`);
  process.exit(1);
}
console.log(`Gateway ${health.version} — profil ${health.profile.mode} (${health.profile.browser}), navigateur ${health.browserStarted ? 'déjà ouvert' : 'pas encore ouvert'}.`);

const models = await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${token}` } });
if (models.status === 401) {
  console.error('Jeton refusé. Relance gateway/install.py puis redémarre le gateway.');
  process.exit(1);
}
const list = await models.json();
console.log(`Modèles proposés (${list.data.length}) :`);
for (const entry of list.data) console.log(`  - ${entry.id}`);
// Accept the model id with any casing, and explain the closest match instead of failing silently.
const exact = requested && list.data.find(entry => entry.id.toLowerCase() === requested.toLowerCase());
const model = exact?.id ?? (requested ? undefined : list.data.find(entry => entry.id.startsWith('glm-web:'))?.id);
if (!model) {
  const near = list.data.filter(entry => entry.id.toLowerCase().includes(String(requested).split(':').pop().toLowerCase())).map(entry => entry.id);
  console.error(`Modèle « ${requested} » absent de la liste.`);
  if (near.length) console.error(`Proche(s) : ${near.join(', ')}`);
  process.exit(1);
}

console.log(`\nEnvoi d’un vrai tour à ${model} (${prompt})…`);
const started = Date.now();
const response = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: false }),
});
const body = await response.json().catch(() => ({}));
if (!response.ok) {
  console.error(`Échec HTTP ${response.status} : ${body?.error?.message || JSON.stringify(body)}`);
  console.error('Vérifie dans la fenêtre du navigateur que tu es connecté, puis réessaie.');
  process.exit(1);
}
console.log(`Réponse en ${((Date.now() - started) / 1000).toFixed(1)}s :`);
console.log(body.choices?.[0]?.message?.content ?? JSON.stringify(body));
console.log('\nLe tour complet a fonctionné. Tu peux sélectionner ce modèle dans Hermes.');
