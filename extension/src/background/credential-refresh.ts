export type ProviderCredential = {
  providerId: string;
  cookies: Record<string, string>;
  token?: string;
  metadata?: unknown;
};

/** Merge provider-specific auth refresh output without persisting transient credentials. */
export function mergeRefreshedCredentials<T extends ProviderCredential>(
  credentials: T,
  refreshed: Record<string, string> | null | undefined,
): T {
  if (!refreshed) return credentials;
  const merged = { ...credentials, cookies: { ...credentials.cookies } };
  for (const [key, value] of Object.entries(refreshed)) {
    if (key === 'token' || key === 'access_token' || key === 'accessToken') merged.token = value;
    else merged.cookies[key] = value;
  }
  merged.token = merged.cookies.chatglm_token ?? merged.token;
  return merged as T;
}
