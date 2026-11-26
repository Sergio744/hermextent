#!/usr/bin/env node
// Starts a Chrome window that the gateway is allowed to drive.
//
// Why a separate profile: since Chrome 136 the remote-debugging switches are ignored for the
// default user-data directory (cookie-theft mitigation), so "attach to my normal Chrome" is
// impossible while Chrome runs with its standard profile. This window therefore uses a
// persistent, gateway-owned profile under the Hermes home: sign in once and the sessions stay
// for every later run. Afterwards `npm run gateway` (with --attach) drives this very window,
// and provider tabs open inside it instead of a second browser.
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';

const port = Number(process.env.HERMES_DEBUG_PORT || 9222);
const home = path.resolve(process.env.HERMES_HOME || path.join(os.homedir(), '.hermes'));
const userDataDir = path.join(home, 'browser-sessions', 'debug-profile');

async function isFile(candidate) {
  try { await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return true; } catch { return false; }
}

async function findBrowser() {
  if (process.env.HERMES_BROWSER_EXECUTABLE) {
    if (!(await isFile(process.env.HERMES_BROWSER_EXECUTABLE))) throw new Error('HERMES_BROWSER_EXECUTABLE ne pointe pas vers un exécutable accessible.');
    return process.env.HERMES_BROWSER_EXECUTABLE;
  }
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const candidates = process.platform === 'win32'
    ? [
        path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  for (const candidate of candidates) if (await isFile(candidate)) return candidate;
  throw new Error('Chrome ou Edge est introuvable. Installe-le ou définis HERMES_BROWSER_EXECUTABLE.');
}

const executable = await findBrowser();
await mkdir(userDataDir, { recursive: true });

const child = spawn(executable, [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${userDataDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  'about:blank',
], { detached: true, stdio: 'ignore' });
child.unref();

console.log(`Navigateur pilotable lancé (PID ${child.pid}).`);
console.log(`Dossier du profil : ${userDataDir}`);
console.log(`Port de pilotage : http://127.0.0.1:${port}`);
console.log('');
console.log('1. Dans la fenêtre qui vient de s’ouvrir, connecte-toi à tes sites (DeepSeek, ChatGPT…).');
console.log('2. Garde cette fenêtre ouverte.');
console.log('3. Lance maintenant, dans un autre terminal : npm run gateway');
console.log('');
console.log('Le gateway réutilisera cet onglet-ci : les sites s’ouvrent dans cette fenêtre, pas ailleurs.');
console.log('Pour rafraîchir les sessions : ferme cette fenêtre, relance npm run chrome:debug.');
