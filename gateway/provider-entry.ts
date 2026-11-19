/** Node-side entry point bundling the existing session-based provider adapters. */
export { getAllPlugins, getPlugin } from '../extension/src/background/web-providers/plugin-registry';
export { mainWorldFetch } from '../extension/src/background/web-providers/content-fetch-main';
export { createSseParser } from '../extension/src/background/web-providers/sse-parser';
export { createXmlTagParser } from '../extension/src/background/web-providers/xml-tag-parser';
export { installPageRequestCancellation } from '../extension/src/background/page-cancellation';
