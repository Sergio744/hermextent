# Hermes Web Gateway

**Hermes Web Gateway** is a local OpenAI-compatible router for Hermes Agent. Instead of installing a Hermes extension in Chrome and connecting it with Native Messaging, it opens a dedicated, persistent browser profile and uses the web sessions you sign into there. No provider API key is required; normal provider account limits, plans, policies, and website changes still apply.

> **Status: experimental preview, not production-validated.** The local gateway, browser-session manager, Hermes provider profile, and adapters for 11 web providers are implemented. Automated tests cover the local HTTP contract and adapter logic. No provider website, Playwright-controlled login, real Hermes runtime, or end-to-end generation has yet been validated in a real user environment. Do not assume any provider works until it is tested.

## Architecture

```text
Hermes Agent
   │ OpenAI-compatible request
   ▼
http://127.0.0.1:20128/v1  — local Hermes Web Gateway
   │ authenticated localhost API
   ▼
Playwright-controlled Chrome/Edge profile
   │ signed-in website session; provider-specific web request
   ▼
Provider website
```

The gateway is a local Node.js process. It launches Chrome or Edge with a **separate profile** under the Hermes home directory, so you sign in once in that window and the session persists there. It does not reuse or copy cookies from your normal Chrome profile. The Chrome extension, Native Messaging host, and Hermes API server are not required for this route.

The local API accepts model IDs in the form `provider-id:model-id`. The current adapter set is `chatgpt-web`, `claude-web`, `deepseek-web`, `doubao-web`, `gemini-web`, `glm-web`, `glm-intl-web`, `kimi-web`, `qwen-cn-web`, `qwen-web`, and `rakuten-web`. These adapters use unofficial website protocols that can change at any time. A cookie indicator in the dashboard is only a heuristic; it does not prove a valid account or successful inference.

## Requirements

- Hermes Agent installed.
- Node.js 22 or newer and npm.
- Python 3.11+ for the profile installer.
- Google Chrome or Microsoft Edge installed. Playwright Core controls the installed browser; this project does not download a separate browser.
- A user account/session on whichever provider site you want to use.

## Troubleshooting

- **“Origine de l’interface locale refusée”** — the dashboard and the gateway must be the same version and the same host. Open `http://127.0.0.1:20128` exactly (not `localhost`, not a proxied preview URL), stop any older gateway with Ctrl+C, and confirm the version badge matches the archive you run. The refusal message now names both origins.
- **No browser window opens** — Chrome/Edge was not found. Install it, or set `HERMES_BROWSER_EXECUTABLE` to the full `chrome.exe`/`msedge.exe` path and restart the gateway. The gateway never downloads a browser.
- **A provider says the session is unverified** — sign in inside the dedicated window, keep it open, then refresh the dashboard. The cookie indicator is only a heuristic.
- **Requests fail with a provider error** — the website protocol may have changed, or the account may not have access to that model. Report the exact message; nothing is silently retried with another provider.

## Install and run on Windows

Extract this project to a permanent folder. Open PowerShell in that folder and run:

```powershell
npm ci
py -3 .\gateway\install.py --hermes-home "$HOME\.hermes"
npm run gateway
```

The installer copies the Hermes provider profile and preserves or creates a local bearer credential in Hermes `.env`; it never prints the credential. Restart Hermes Agent/Desktop after installation so it loads the provider profile. Keep the project folder in place while running the gateway. If Chrome is installed in a nonstandard location, set `HERMES_BROWSER_EXECUTABLE` to its executable path before starting the gateway.

Always run `npm run gateway` from the folder you just extracted, so the gateway code matches the dashboard you open. The dashboard shows its version next to the title and `/health` reports the same `version`; if those differ from the archive you downloaded, an older gateway is still running or the files were not replaced.

Open `http://127.0.0.1:20128` in your normal browser. Choose **Ouvrir la session web** for a provider. The gateway opens its dedicated browser window; sign in there. The dedicated profile is stored under `$HOME\.hermes\browser-sessions` (on Windows, usually `C:\Users\<you>\.hermes\browser-sessions`). Repeat for any other provider. Keep the gateway running while Hermes uses it.

On Linux/macOS, run `npm ci`, `python3 gateway/install.py`, then `npm run gateway`; the gateway tries to locate Chrome/Edge. Set `HERMES_BROWSER_EXECUTABLE` if auto-detection does not find your browser.

## Configure Hermes

The installer places the `hermes-browser` provider profile in the Hermes home directory. Select it in Hermes, for example:

```yaml
model:
  provider: hermes-browser
  model: gemini-web:gemini-3-flash
```

Choose any listed provider/model supported by the current website adapter. Model identifiers and website availability may change. The `HERMEXTENT_BRIDGE_TOKEN` used by the Hermes profile is a **local gateway password**, not a provider API key. It stays in Hermes `.env`; do not paste or publish it. The gateway binds only to `127.0.0.1`, checks the bearer credential, and rejects non-loopback hosts.

## Commands and endpoints

```sh
npm ci
npm run build:gateway  # bundle the shared web-provider code
npm run gateway        # build the provider bundle and start the gateway
npm test               # automated tests; no logged-in provider session is used
npm run check          # build, typecheck, tests, and npm audit
```

- Dashboard: `http://127.0.0.1:20128/`
- Health: `http://127.0.0.1:20128/health`
- Models: `GET /v1/models` (local bearer credential required)
- Completions: `POST /v1/chat/completions` (local bearer credential required; streaming and non-streaming)

The process can be stopped with Ctrl+C. To sign out, use the provider website in the dedicated browser profile. To remove sessions, stop the gateway and remove only the `browser-sessions` directory after confirming you no longer need those logins. Do not delete Hermes `.env` as part of routine troubleshooting; it may contain other settings.

## Migration from the 0.1.0 Chrome-extension prototype

Do not remove the old extension until the gateway has started, the Hermes profile has been updated, and at least one real web-session request has succeeded. After that:

1. Remove **Hermes Browser** from `chrome://extensions`.
2. From the project folder, unregister the old Native Messaging host with `py -3 .\companion\uninstall.py --browser chrome` (Windows) or `python companion/uninstall.py --browser chrome` (macOS/Linux).
3. Do **not** add `--remove-plugin` or `--remove-token`: the new gateway still uses the `hermes-browser` provider profile and the local bearer credential in Hermes `.env`.

This cleanup does not erase the dedicated `browser-sessions` profile. Sign out in the dedicated browser or remove only that directory if you intentionally want to delete its website sessions.

## Security and provider limitations

- The gateway listens only on IPv4 loopback (`127.0.0.1`); it is not a LAN or public proxy. The API requires the local bearer credential and validates the host header.
- Provider sessions are saved by the browser in the dedicated `browser-sessions` profile. Anyone with access to that Windows/macOS/Linux user account may be able to use those sessions. Protect the OS account and profile directory.
- The dashboard's cookie badges are best-effort indicators only. Some providers store authentication in local storage or rotate cookies; a badge is not proof of a valid session.
- Web protocols are unofficial and may be incompatible with provider terms, change without notice, hit account limits, or trigger security checks. This project does not bypass subscriptions, quotas, or provider controls.
- The gateway does not promise all Hermes capabilities at this stage. Tool calls are translated through provider prompts and parsers; approvals, files, images, audio, long-running tasks, and other Hermes surfaces need their own verified end-to-end work.
- The original MV3 extension and Native Messaging companion remain in the repository as a legacy experimental path, but are no longer required by the primary gateway setup. Do not install both as if they were the same route: the extension uses the old Native Messaging relay while the gateway uses port 20128.

## Validation status

See [the capability matrix](docs/capability-matrix.md) and [validation log](docs/validation-log.md). Unit/integration tests use synthetic provider payloads and a temporary local Hermes home. They do not establish that a site currently accepts the request, that a session is valid, that Playwright injection works under the site's current browser policy, or that a real Hermes tool call completes. Those tests must be performed with explicit user accounts and documented individually before a production claim.

## Development

Provider definitions, stream adapters, and parsers are currently shared with the legacy extension under `extension/src/background/web-providers/`. The gateway bundles these sources with esbuild, then runs provider fetch handlers inside a same-origin page in the dedicated browser context so website cookies and page-only state remain available. `gateway/provider-entry.ts` is the bundling boundary; `gateway/server.mjs` implements the local OpenAI-compatible router; `gateway/browser-session.mjs` owns the persistent browser context and login pages.

```sh
npm ci
npm run check
```

Third-party notices for ChromeClaw and Hermes source are preserved in `THIRD_PARTY_NOTICES.md`.
