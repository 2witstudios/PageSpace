/** The org Drives page (UI-7, canvas Drives): pure pieces. */
import { orgRoleAtLeast } from '@pagespace/lib/organizations/org-roles';
import type { OrgDriveDirectoryEntry } from './org-api';

export function driveMembersLabel(usage: { memberCount: number; guestCount: number } | undefined): string {
  if (!usage) return '';
  if (usage.guestCount === 0) return String(usage.memberCount);
  return `${usage.memberCount} · ${usage.guestCount} ${usage.guestCount === 1 ? 'guest' : 'guests'}`;
}

export const VISIBILITY_COPY: Record<OrgDriveDirectoryEntry['orgVisibility'], { label: string; tone: 'open' | 'restricted' | 'private'; description: string }> = {
  OPEN: {
    label: 'Open',
    tone: 'open',
    description: "Every org member can find and open it, with the drive's default role. That role is never below the org's floor (View or Edit). No invite needed.",
  },
  RESTRICTED: {
    label: 'Restricted',
    tone: 'restricted',
    description: 'Listed here for org members, not in their drive picker. They ask to join and the drive lead approves; only then does it open.',
  },
  PRIVATE: {
    label: 'Private',
    tone: 'private',
    description: 'Invite only. Not listed to members. Org admins can still manage it, and that is recorded in the audit log.',
  },
};

/** DRV-1/DRV-2: a personal drive the person owns can move in; Home never can, and trashed drives cannot. */
export function movableDrives<D extends { isOwned: boolean; orgId?: string | null; isTrashed: boolean; kind?: 'STANDARD' | 'HOME' }>(drives: readonly D[]): D[] {
  return drives.filter((d) => d.isOwned && !d.orgId && !d.isTrashed && d.kind !== 'HOME');
}

/**
 * Who answers a Restricted drive's join requests (DRV-6): its lead, or an org Owner or Admin — the
 * rule decideJoinRequestApprover enforces on the route. Only a Restricted drive has requests.
 */
export function mayAnswerJoinRequests(
  drive: { orgId?: string | null; orgVisibility?: OrgDriveDirectoryEntry['orgVisibility']; isOwned: boolean },
  orgRole: 'OWNER' | 'ADMIN' | 'MEMBER' | undefined,
): boolean {
  if (!drive.orgId || drive.orgVisibility !== 'RESTRICTED') return false;
  return drive.isOwned || orgRoleAtLeast(orgRole, 'ADMIN');
}

/**
 * What the org Drives directory offers on one drive (DRV-6, D-OW-25): open one I am on, ask to
 * join a Restricted one, wait on a request I sent, accept an invitation I hold (from my
 * notifications, not here), or manage a Private drive an org admin is not on.
 */
export type DirectoryAction = 'open' | 'request' | 'requested' | 'invited' | 'manage';

export function directoryAction(entry: Pick<OrgDriveDirectoryEntry, 'orgVisibility' | 'joined' | 'joinRequest' | 'canRequest'>): DirectoryAction {
  if (entry.joined) return 'open';
  if (entry.orgVisibility === 'PRIVATE') return 'manage';
  if (entry.joinRequest === 'pending') return 'requested';
  return entry.canRequest ? 'request' : 'invited';
}

export interface DirectorySection {
  /** mine: drives I am on; restricted: Restricted drives I may ask to join; admin: Private drives only an admin sees. */
  kind: 'mine' | 'restricted' | 'admin';
  drives: OrgDriveDirectoryEntry[];
}

const SECTION_OF: Record<DirectoryAction, DirectorySection['kind']> = {
  open: 'mine',
  request: 'restricted',
  requested: 'restricted',
  invited: 'restricted',
  manage: 'admin',
};

/** The directory's groups in order, keeping the server's order (by name) inside each; empty groups are left out. */
export function directorySections(entries: readonly OrgDriveDirectoryEntry[]): DirectorySection[] {
  const order: DirectorySection['kind'][] = ['mine', 'restricted', 'admin'];
  return order
    .map((kind) => ({ kind, drives: entries.filter((e) => SECTION_OF[directoryAction(e)] === kind) }))
    .filter((s) => s.drives.length > 0);
}
