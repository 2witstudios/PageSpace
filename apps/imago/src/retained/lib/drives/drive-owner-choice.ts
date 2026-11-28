/**
 * DRV-3: who owns a drive created from the create-drive dialog. Pure.
 *
 * The org context is concrete: an org named by the caller (the dialog opened from that org's
 * header), else the org that owns the drive the person is in. The dialog offers Personal plus the
 * orgs the server says this person may create drives in (canCreateDrives, from GET /api/orgs:
 * role against the who-can-create policy, not lapsed); a context org outside that list falls back
 * to Personal. The server decides again when the drive is created (createOrgDrive).
 */
export interface DriveOwnerOrg {
  id: string;
  name: string;
  canCreateDrives?: boolean;
}

export const creatableOrgs = <O extends DriveOwnerOrg>(orgs: readonly O[]): O[] =>
  orgs.filter((org) => org.canCreateDrives === true);

export const driveOrgContext = (input: {
  explicitOrgId: string | null | undefined;
  currentDriveId: string | null;
  drives: ReadonlyArray<{ id: string; orgId?: string | null }>;
}): string | null =>
  input.explicitOrgId ?? input.drives.find((drive) => drive.id === input.currentDriveId)?.orgId ?? null;

/** The owner the dialog starts on: the context org when it is offered, otherwise Personal (null). */
export const defaultDriveOwner = (contextOrgId: string | null, offered: readonly DriveOwnerOrg[]): string | null =>
  contextOrgId !== null && offered.some((org) => org.id === contextOrgId) ? contextOrgId : null;
