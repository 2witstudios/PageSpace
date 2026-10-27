/**
 * DRV-3: the one way every door creates a drive — the create-drive dialog (POST /api/drives), the
 * AI create_drive tool and the MCP POST /api/mcp/drives. With no orgId the drive is personal; with
 * one it is org-owned from creation through createOrgDrive, which decides membership and the
 * "who can create org drives" policy inside its transaction (requireOrgRole, the one org permission
 * function). Creating a drive is not a money move, so a token may do it ([D-OW-26]); the org's
 * sign-in policy (SEC-2/SEC-3) still applies to the credential that asks, judged by createOrgDrive
 * after membership.
 */
import type { VerifiedAuthentication } from '@pagespace/lib/auth/authentication-evidence';
import { createDrive, type DriveWithAccess } from '@pagespace/lib/services/drive-service';
import { createOrgDrive } from '@pagespace/lib/services/org-drive-service';
import { orgDriveServiceDeps } from '@pagespace/lib/services/org-drive-service-deps';
import { isReservedDriveName } from '@pagespace/lib/services/drive-guards';
import type { OrgDriveVisibility } from '@pagespace/db/schema/core';

export interface CreateDriveForCallerInput {
  userId: string;
  name: string;
  /** The org that owns the new drive; absent for a personal drive. */
  orgId?: string;
  orgVisibility?: OrgDriveVisibility;
  drivePrompt?: string | null;
  /** The asking credential's verified authentication, judged against the org's credential policy. */
  authentication: VerifiedAuthentication | null | undefined;
}

export type CreateDriveForCallerResult =
  | { ok: true; drive: DriveWithAccess }
  | { ok: false; status: number; error: string; code?: string };

export async function createDriveForCaller(input: CreateDriveForCallerInput): Promise<CreateDriveForCallerResult> {
  const name = input.name.trim();
  if (!name) return { ok: false, status: 400, error: 'Drive name is required' };
  if (isReservedDriveName(name)) return { ok: false, status: 400, error: 'Cannot create a drive with that name.' };

  if (input.orgId === undefined) {
    return { ok: true, drive: await createDrive(input.userId, { name, drivePrompt: input.drivePrompt }) };
  }

  // Membership, the who-can-create policy and then the org's sign-in policy are all decided inside the
  // create transaction, in that order, so a non-member learns nothing about the org's sign-in policy.
  const created = await createOrgDrive(
    input.userId,
    { name, orgId: input.orgId, orgVisibility: input.orgVisibility, drivePrompt: input.drivePrompt, authentication: input.authentication ?? null },
    orgDriveServiceDeps,
  );
  if (!created.ok) return { ok: false, status: created.status, error: created.message, code: created.code };
  // The creator leads the new drive, so the drive-wide canEdit rule (#2627) grants create, as createDrive does.
  return { ok: true, drive: { ...created.drive, isOwned: true, role: 'OWNER', canCreatePages: true, lastAccessedAt: null } };
}
