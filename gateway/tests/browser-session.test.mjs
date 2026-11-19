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
