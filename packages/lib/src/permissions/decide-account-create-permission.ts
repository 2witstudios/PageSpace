/**
 * `decideAccountCreatePermission` — who may create an agent account (L2·G2;
 * ADR 0004 §4.1: creation is `manage` + `grant` on an account that does not
 * exist yet, so it follows their rule). User-owned: the owner only.
 * Agent-page-owned: the HUMAN actor is the drive's OWNER or ADMIN — never a
 * MEMBER, never an agent's own membership (B0 B-24). Page permissions grant
 * nothing here. Pure.
 */
import type { AccountOwnerRef } from '@pagespace/db/schema/agent-accounts';
import type { UserId } from '../agent-accounts/grant';
import type { DriveRoleOfHuman } from './account-permissions';

export function decideAccountCreatePermission({
  owner,
  actorUserId,
  humanDriveRole,
}: {
  readonly owner: AccountOwnerRef;
  readonly actorUserId: UserId;
  /** The actor's role in the owner page's drive; ignored for a user-owned account. */
  readonly humanDriveRole: DriveRoleOfHuman;
}): boolean {
  if (owner.kind === 'user') return owner.userId === actorUserId;
  return humanDriveRole === 'OWNER' || humanDriveRole === 'ADMIN';
}
