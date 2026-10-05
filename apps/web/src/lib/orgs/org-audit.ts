/** The org Audit log page (AUD-3, UI-7, canvas AuditLog): plain-words copy per catalogued event, and the query. */
import type { OrgAuditCatalogType, OrgAuditCategory } from '@pagespace/lib/audit/org-audit-query-core';

/** Exhaustive over the catalog: an event added without copy fails tsc. Reads after the actor's name. */
export const AUDIT_EVENT_SENTENCES: Record<OrgAuditCatalogType, string> = {
  'org.created': 'created the organization',
  'org.updated': 'changed the organization’s name or URL',
  'org.deleted': 'deleted the organization',
  'org.ownership.transferred': 'transferred ownership',
  'org.member.joined': 'joined',
  'org.member.auto_joined': 'joined through a verified domain',
  'org.member.auto_join_refused': 'was not let in through a verified domain',
  'org.member.role_changed': 'changed a member’s role',
  'org.member.removed': 'removed a member',
  'org.member.left': 'left the organization',
  'org.member.suppression_cleared': 'let a removed person rejoin by domain',
  'org.seat.auto_add_changed': 'changed automatic seats',
  'org.seat.quantity_changed': 'changed the number of seats',
  'org.seat.refused': 'was refused a seat because every seat is in use',
  'org.invite.created': 'invited someone',
  'org.invite.resent': 'resent an invitation',
  'org.invite.revoked': 'revoked an invitation',
  'org.policy.changed': 'changed a policy',
  'org.policy.suspended': 'suspended items a policy now forbids',
  'org.policy.restored': 'restored items a policy allows again',
  'org.policy.blocked': 'blocked items a policy now forbids',
  'org.guest.requested': 'asked to bring in a guest',
  'org.guest.approved': 'approved a guest',
  'org.guest.declined': 'declined a guest',
  'org.domain.added': 'added a domain',
  'org.domain.verification_sent': 'sent a domain verification email',
  'org.domain.verified': 'verified a domain',
  'org.domain.removed': 'removed a domain',
  'org.drive.visibility_changed': 'changed a drive’s visibility',
  'org.drive.join_requested': 'asked to join a drive',
  'org.drive.join_approved': 'approved a request to join a drive',
  'org.drive.join_declined': 'declined a request to join a drive',
  'org.drive.join_withdrawn': 'withdrew a request to join a drive',
  'org.drive.created': 'created an org drive',
  'org.drive.moved_in': 'moved a drive into the organization',
  'org.drive.moved_out': 'moved a drive out of the organization',
  'org.drive.lead_changed': 'changed a drive’s lead',
  'authz.access.granted': 'opened a Private drive as an org admin',
  'org.wallet.allocation_changed': 'changed a wallet or seat cap',
  'org.wallet.topped_up': 'added credits to a wallet',
  'org.wallet.donated': 'donated credits to a drive wallet',
  'org.billing.subscription_changed': 'billing changed',
  'org.billing.pool_refilled': 'the credits pool was refilled',
  'org.compute.reattributed': 'handed compute costs to a drive lead',
  'org.app.unparked': 'took back a parked app',
};

export const AUDIT_CATEGORY_LABELS: Record<OrgAuditCategory, string> = {
  membership: 'Members',
  seats: 'Seats',
  invites: 'Invitations',
  policies: 'Policies',
  domains: 'Domains',
  visibility: 'Drive visibility',
  drive_moves: 'Drives',
  private_drive_access: 'Admin access',
  wallets: 'Wallets',
  donations: 'Donations',
  billing: 'Billing',
  compute: 'Compute',
};

export function auditSentence(eventType: string): string {
  return (AUDIT_EVENT_SENTENCES as Record<string, string>)[eventType] ?? 'made a change';
}

export interface AuditFilters {
  category: OrgAuditCategory | 'all';
  driveId: string | 'any';
  /** Look-back in days; null = all time. */
  days: number | null;
  before?: number;
}

const DAY_MS = 86_400_000;

/** The query for GET /api/orgs/[orgId]/audit and /audit/export (AUD-3). */
export function auditQueryString(filters: AuditFilters, nowMs: number): string {
  const params = new URLSearchParams();
  if (filters.category !== 'all') params.set('category', filters.category);
  if (filters.driveId !== 'any') params.set('driveId', filters.driveId);
  if (filters.days !== null) params.set('from', new Date(nowMs - filters.days * DAY_MS).toISOString());
  if (filters.before !== undefined) params.set('before', String(filters.before));
  return params.toString();
}
