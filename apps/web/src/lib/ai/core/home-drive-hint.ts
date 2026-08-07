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
  allowedDriveIds: readonly string[] = [],
): Promise<string | undefined> {
  // Only the no-location branch renders it, so the common in-a-drive path pays
  // no query at all.
  if (hasLocation) return undefined;
  try {
    const drive = await getHomeDrive(userId);
    if (!drive) return undefined;

    // Ceiling the hint to the caller's drive scope. Empty = session auth =
    // unscoped; non-empty = a scoped MCP/OAuth token that may only reach those
    // drives. This mirrors what the route already does for the member-drive
    // context block, which filters the same way for the same reason: it is a
    // value the ROUTE reads directly, so the tool layer's ceiling never sees it.
    //
    // Two things go wrong without it. The id itself is disclosed to a token
    // that may not reach that drive. And it is actively misleading: the /plan
    // body tells the agent to create driveless plans in Home, so the agent
    // would be steered into a `create_page` call that `driveOutsideMcpScope`
    // rejects every time.
    if (allowedDriveIds.length > 0 && !allowedDriveIds.includes(drive.id)) return undefined;

    return drive.id;
  } catch {
    return undefined;
  }
}
