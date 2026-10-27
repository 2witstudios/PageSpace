/**
 * Type-guarded extraction of the two connect-dialog fields from a provider
 * config. Custom/admin-created providers accept arbitrary `config`, so a
 * malformed `oauthScopeDescriptions` (non-record, or non-string values) or
 * `connectNotes` (non-string) must not reach the client, where the connect
 * dialog iterates and renders them. Returns only well-formed values; anything
 * else becomes null.
 */
export function sanitizeConnectMetadata(config: unknown): {
  oauthScopeDescriptions: Record<string, string> | null;
  connectNotes: string | null;
} {
  const cfg = (config ?? null) as Record<string, unknown> | null;

  const rawScopes = cfg?.oauthScopeDescriptions;
  let oauthScopeDescriptions: Record<string, string> | null = null;
  if (rawScopes && typeof rawScopes === 'object' && !Array.isArray(rawScopes)) {
    const entries = Object.entries(rawScopes as Record<string, unknown>).filter(
      ([, v]) => typeof v === 'string'
    ) as [string, string][];
    if (entries.length > 0) oauthScopeDescriptions = Object.fromEntries(entries);
  }

  const connectNotes = typeof cfg?.connectNotes === 'string' ? cfg.connectNotes : null;

  return { oauthScopeDescriptions, connectNotes };
}
