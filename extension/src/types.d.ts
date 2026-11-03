declare module '@extension/shared' {
  export type ThinkingLevel = 'fast' | 'thinking' | 'balanced' | 'deep' | 'max';
}
declare module '@extension/storage' {
  export type WebProviderCredential = {
    providerId: string;
    cookies: Record<string, string>;
    token?: string;
    metadata?: Record<string, string>;
    lastRequestAt?: number;
    capturedAt?: number;
  };
}
