/** The org Drives page (UI-7, canvas Drives): pure pieces. */
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
