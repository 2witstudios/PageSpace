/**
 * Resolves the sender's Home drive id for the LOCATION block's no-location
 * branch — `list_drives` returns neither drive kind nor a Home marker, so an
 * agent standing nowhere otherwise has no way to name Home, which the /plan
 * skill needs as the destination for a personal plan artifact.
 *
 * Shared by both chat routes so the two surfaces can't drift on when the hint
 * appears.
 *
 * Fail-closed to `undefined`, never throw: this is a convenience hint, and no
 * chat request should fail because a drive lookup did. The try/catch (rather
 * than `.catch()`) is deliberate — it also covers a synchronous throw, which a
 * promise handler would miss entirely.
 */

import { getHomeDrive } from '@pagespace/lib/services/drive-service';

export async function resolveHomeDriveHint(
  userId: string,
  hasLocation: boolean,
): Promise<string | undefined> {
  // Only the no-location branch renders it, so the common in-a-drive path pays
  // no query at all.
  if (hasLocation) return undefined;
  try {
    const drive = await getHomeDrive(userId);
    return drive?.id;
  } catch {
    return undefined;
  }
}
