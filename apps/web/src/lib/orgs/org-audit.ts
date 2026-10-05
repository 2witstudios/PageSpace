/** The org Audit log page (AUD-3, UI-7, canvas AuditLog): plain-words copy per catalogued event, and the query. */
import type { OrgAuditCatalogType, OrgAuditCategory } from '@pagespace/lib/audit/org-audit-query-core';
import { formatCreditCount, formatDollars } from '@pagespace/lib/billing/money-model';
import { countPhrases, policyValueWords, POLICY_LABELS } from './org-policies';
import { VISIBILITY_COPY } from './org-drives';

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
  'org.automation.owner_left': 'paused an automation whose owner is no longer here',
  'org.automation.reassigned': 'handed an automation to a new owner',
  'org.automation.deleted': 'deleted an automation whose owner is no longer here',
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
  automations: 'Automations',
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

const ROLE_WORDS: Record<string, string> = { OWNER: 'Owner', ADMIN: 'Admin', MEMBER: 'Member' };
const VISIBILITY_WORDS: Record<string, string> = Object.fromEntries(Object.entries(VISIBILITY_COPY).map(([k, v]) => [k, v.label]));
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const word = (map: Record<string, string>, v: unknown) => (typeof v === 'string' ? map[v] ?? '' : '');
const arrow = (from: string, to: string) => (from && to ? `${from} → ${to}` : '');

/**
 * What an org audit event changed, in plain words, from an ALLOWLIST of `details` keys per event (AUD-1,
 * AUD-3). Identifiers and email addresses are never printed; an unknown event or shape reads as ''.
 */
export function auditDetailLine(eventType: string, details: Record<string, unknown>): string {
  switch (eventType) {
    case 'org.policy.changed': {
      if (!Array.isArray(details.changes)) return '';
      return details.changes
        .filter(isRecord)
        .flatMap((c) => {
          const key = typeof c.key === 'string' ? c.key : '';
          const label = (POLICY_LABELS as Record<string, string>)[key];
          if (!label) return [];
          const from = policyValueWords(key, c.from);
          const to = policyValueWords(key, c.to);
          if (!from || !to) return [`${label} changed`];
          return [`${label}: ${from} → ${to}${key === 'seatAllowanceCents' ? ' credits a month' : ''}`];
        })
        .join(' · ');
    }
    case 'org.policy.suspended':
    case 'org.policy.restored':
    case 'org.policy.blocked': {
      if (!isRecord(details.counts)) return '';
      const verb = eventType === 'org.policy.suspended' ? 'suspended' : eventType === 'org.policy.restored' ? 'restored' : 'now blocked';
      const counts = Object.fromEntries(Object.entries(details.counts).map(([k, v]) => [k, num(v) ?? 0]));
      return countPhrases(counts, verb).join(' · ');
    }
    case 'org.member.role_changed':
      return arrow(word(ROLE_WORDS, details.from), word(ROLE_WORDS, details.to));
    case 'org.drive.visibility_changed':
      return arrow(word(VISIBILITY_WORDS, details.from), word(VISIBILITY_WORDS, details.to));
    case 'org.drive.moved_in':
    case 'org.drive.created': {
      const v = word(VISIBILITY_WORDS, details.orgVisibility);
      return v ? `as ${v}` : '';
    }
    case 'org.drive.moved_out':
      return details.implicitMembers === 'keep' ? 'org members kept their access' : details.implicitMembers === 'remove' ? 'org members lost their access' : '';
    case 'org.invite.created': {
      const role = word(ROLE_WORDS, details.role);
      return role ? `as ${role}` : '';
    }
    case 'org.seat.auto_add_changed':
      return typeof details.autoAdd === 'boolean' ? `Automatic seats ${details.autoAdd ? 'on' : 'off'}` : '';
    case 'org.seat.refused': {
      const held = num(details.held);
      const purchased = num(details.purchased);
      return held !== null && purchased !== null ? `${held} of ${purchased} seats in use` : '';
    }
    case 'org.billing.pool_refilled': {
      const paid = num(details.paidCents);
      const granted = num(details.allowanceCents);
      return [paid !== null ? `${formatDollars(paid)} paid` : null, granted !== null ? `${formatCreditCount(granted)} credits added to the pool` : null].filter(Boolean).join(' · ');
    }
    case 'org.domain.added':
    case 'org.domain.removed':
    case 'org.domain.verified':
    case 'org.domain.verification_sent': {
      const domain = typeof details.domain === 'string' ? details.domain : '';
      const how = details.method === 'dns' ? 'by DNS' : details.method === 'email' ? 'by email' : '';
      return [domain, how].filter(Boolean).join(' · ');
    }
    case 'org.member.left':
    case 'org.member.removed': {
      const n = num(details.drivesReassigned);
      return n ? `${n} ${n === 1 ? 'drive' : 'drives'} handed to another lead` : '';
    }
    default:
      return '';
  }
}
