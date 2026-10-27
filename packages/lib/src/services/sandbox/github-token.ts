import type { db as defaultDb } from '@pagespace/db/db';
import { getProviderBySlug } from '../../integrations/repositories/provider-repository';
import { findUserConnection } from '../../integrations/repositories/connection-repository';
import { decryptCredentials } from '../../integrations/credentials/encrypt-credentials';

export async function resolveGitHubTokenForSandbox({
  userId,
  db,
}: {
  userId: string;
  db: typeof defaultDb;
}): Promise<string | null> {
  try {
    const provider = await getProviderBySlug(db, 'github');
    if (!provider) return null;

    const connection = await findUserConnection(db, userId, provider.id);
    if (!connection || connection.status !== 'active') return null;

    if (
      !connection.credentials ||
      Object.keys(connection.credentials as object).length === 0
    ) {
      return null;
    }

    const creds = await decryptCredentials(
      connection.credentials as Record<string, string>
    );
    return creds.accessToken ?? null;
  } catch {
    return null;
  }
}
