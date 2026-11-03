import type { WebProviderPlugin } from '../plugin-types';
import { chatgptWeb } from './chatgpt-web';
import { createChatGPTStreamAdapter } from './chatgpt-stream-adapter';
import { chatgptToolStrategy } from '../tool-strategy';
import { chatgptMainWorldFetch } from '../content-fetch-chatgpt';

export const chatgptWebPlugin: WebProviderPlugin = {
  definition: chatgptWeb,
  createStreamAdapter: () => createChatGPTStreamAdapter(),
  toolStrategy: chatgptToolStrategy,
  contentFetchHandler: chatgptMainWorldFetch,
};
