/**
 * Kimi SSE stream adapter — handles Connect Protocol JSON frames
 * with done detection and error frame handling.
 */

import type { SseStreamAdapter } from '../sse-stream-adapter';

const createKimiStreamAdapter = (): SseStreamAdapter => {
  let serverError: string | undefined;

  return {
    processEvent({ parsed, delta }) {
      const obj = parsed as Record<string, unknown>;

      // End-of-stream frame — emit any final delta
      if (obj.done === true) {
        return delta ? { feedText: delta } : null;
      }

      // Detect top-level error frames
      if (obj.error) {
        const err = obj.error as Record<string, unknown>;
        const msg = (err.message ?? err.code ?? 'Unknown Kimi error') as string;
        throw new Error(msg);
      }

      // Detect block-level exceptions (e.g. REASON_COMPLETION_OVERLOADED)
      if (obj.op === 'set' && obj.mask === 'block.exception') {
        const block = obj.block as Record<string, unknown> | undefined;
        const exception = block?.exception as Record<string, unknown> | undefined;
        const error = exception?.error as Record<string, unknown> | undefined;
        if (error) {
          const localized = error.localizedMessage as Record<string, unknown> | undefined;
          serverError = (localized?.message ?? error.reason ?? 'Kimi server error') as string;
        }
        return null;
      }

      // Regular text delta
      return delta ? { feedText: delta } : null;
    },

    flush() {
      return null;
    },

    shouldAbort() {
      return false;
    },

    onFinish({ hasToolCalls, fullText }) {
      // Surface server errors (e.g. overloaded) captured during streaming
      if (serverError) {
        return { error: serverError };
      }
      // Empty response with no tool calls — Kimi dropped the response
      if (!hasToolCalls && !fullText) {
        return { error: 'Kimi returned an empty response' };
      }
      return null;
    },
  };
};

export { createKimiStreamAdapter };
