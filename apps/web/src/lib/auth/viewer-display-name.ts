import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { decryptUserRow } from '@pagespace/lib/auth/user-repository';

/**
 * The signed-in viewer's display name for the v3 frame's "Signed in as" avatar.
 * `users.name` is encrypted at rest, so it is decrypted at the read edge.
 */
export async function getViewerDisplayName(userId: string): Promise<string | undefined> {
  const row = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { name: true },
  });
  if (!row) return undefined;
  const decrypted = await decryptUserRow(row);
  const name = decrypted.name?.trim();
  return name ? name : undefined;
}
