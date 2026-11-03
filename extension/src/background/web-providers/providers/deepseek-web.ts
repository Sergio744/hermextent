/**
 * DeepSeek (chat.deepseek.com) — web provider using Proof-of-Work challenges.
 *
 * Uses binaryProtocol: 'deepseek' to trigger MAIN world request building
 * (same pattern as GLM Intl), since:
 * - PoW challenge must be fetched and solved before each completion request
 * - Bearer token needs MAIN world access (cookies / localStorage)
 * - Special per-request headers (x-ds-pow-response, x-client-platform, etc.)
 *
 * The lightweight stub body ({ prompt, chatId }) is parsed by the MAIN world
 * handler in content-fetch-main.ts, which builds the real API request.
 */

import type { WebProviderDefinition } from '../types';

const deepseekWeb: WebProviderDefinition = {
  id: 'deepseek-web',
  name: 'DeepSeek (Web)',
  loginUrl: 'https://chat.deepseek.com',
  cookieDomain: '.deepseek.com',
  sessionIndicators: ['ds_session_id', 'HWSID'],
  defaultModelId: 'deepseek-chat',
  defaultModelName: 'DeepSeek V3',
  supportsTools: true,
  supportsReasoning: true,
  contextWindow: 64_000,
  refreshAuth: async ({ tabId }) => {
    // DeepSeek stores its auth JWT in localStorage as `userToken`.
    // This logic mirrors extractBearerToken() in content-fetch-main.ts.
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async () => {
        // 1. Primary key: userToken
        const tryParseToken = (raw: string | null): string => {
          if (!raw) return '';
          try {
            const parsed = JSON.parse(raw);
            if (typeof parsed === 'string') return parsed;
            if (typeof parsed === 'object' && parsed !== null) {
              return (parsed.token ?? parsed.value ?? parsed.access_token ?? parsed.jwt ?? '') as string;
            }
          } catch { /* not JSON */ }
          return raw;
        };

        let bearer = tryParseToken(localStorage.getItem('userToken'));

        // 2. Fallback: other known keys
        if (!bearer) {
          for (const key of ['token', 'ds_token', 'auth_token', 'access_token', 'jwt']) {
            const val = localStorage.getItem(key);
            if (val && val.length > 10) {
              bearer = tryParseToken(val);
              if (bearer) break;
            }
          }
        }

        // 3. Broader scan: any key with "token"/"auth" in the name
        if (!bearer) {
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key || key === 'userToken') continue;
            const lk = key.toLowerCase();
            if (lk.includes('token') || lk.includes('auth') || lk.includes('jwt') || lk.includes('bearer')) {
              const val = localStorage.getItem(key);
              if (val && val.length > 10) {
                bearer = tryParseToken(val);
                if (bearer) break;
              }
            }
          }
        }

        // 4. API fallback: fetch token from /api/v0/users/current
        if (!bearer) {
          try {
            const res = await fetch('https://chat.deepseek.com/api/v0/users/current', {
              credentials: 'include',
            });
            if (res.ok) {
              const data = (await res.json()) as Record<string, unknown>;
              const inner = data.data as Record<string, unknown> | undefined;
              const biz = (inner?.biz_data ?? inner) as Record<string, string> | undefined;
              if (biz?.token) bearer = biz.token;
            }
          } catch { /* ignore */ }
        }

        return bearer || null;
      },
    });
    const token = results?.[0]?.result as string | null;
    return token ? { token } : null;
  },
  buildRequest: opts => {
    // Strategy builds the full prompt in opts.messages[0].content
    const prompt = opts.messages[0]?.content ?? '';
    const chatId = opts.conversationId;

    return {
      url: 'https://chat.deepseek.com/api/v0/chat/completion',
      binaryProtocol: 'deepseek',
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Lightweight body — real request is built in MAIN world (content-fetch-main.ts)
        body: JSON.stringify({ prompt, chatId }),
        credentials: 'include' as RequestCredentials,
      },
    };
  },
  parseSseDelta: () => null, // Handled by deepseek stream adapter
};

export { deepseekWeb };
