import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { integrationConnections } from '@pagespace/db/schema/integrations';
import { decryptCredentials } from '../../integrations/credentials/encrypt-credentials';
import { resolveProviderConfig } from '../../integrations/providers/builtin-providers';

export interface OAuthRevokeResult {
  revoked: number;
  failed: number;
}

interface ConnectionWithProvider {
  id: string;
  credentials: unknown;
  provider: { slug: string; providerType: string; config: unknown } | null;
}

/**
 * Best-effort upstream OAuth revoke. Never throws — a malformed or
 * unexpectedly-shaped provider config must not block marking the connection
 * revoked in the DB below, since that DB write is what erasure depends on.
 */
async function attemptUpstreamRevoke(connection: ConnectionWithProvider): Promise<void> {
  if (!connection.credentials) return;

  try {
    const providerConfig = resolveProviderConfig(connection.provider);
    if (providerConfig?.authMethod.type !== 'oauth2') return;

    const revokeUrl = providerConfig.authMethod.config?.revokeUrl;
    if (!revokeUrl) return;

    const credentials = await decryptCredentials(connection.credentials as Record<string, string>);
    const accessToken = credentials.accessToken || credentials.access_token;
    if (!accessToken) return;

    await fetch(revokeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(accessToken)}`,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Upstream revoke failure is non-fatal — token may be expired, provider
    // unreachable, or the persisted config may be malformed/unexpected shape.
  }
}

/**
 * Revoke all OAuth tokens for a user before account erasure (Art. 17 GDPR).
 *
 * For each user-scoped integration connection:
 * 1. Attempt to call the upstream revoke endpoint (best-effort, non-fatal)
 * 2. Mark the DB record as 'revoked' regardless of HTTP result
 *
 * Failures are counted but never block account deletion.
 */
export async function revokeUserIntegrationTokens(userId: string): Promise<OAuthRevokeResult> {
  const connections = await db.query.integrationConnections.findMany({
    where: eq(integrationConnections.userId, userId),
    with: { provider: true },
  });

  let revoked = 0;
  let failed = 0;

  for (const connection of connections) {
    await attemptUpstreamRevoke(connection);

    try {
      await db
        .update(integrationConnections)
        .set({ status: 'revoked' })
        .where(eq(integrationConnections.id, connection.id));

      revoked++;
    } catch {
      // DB update failure: count as failed, don't block account deletion
      failed++;
    }
  }

  return { revoked, failed };
}
