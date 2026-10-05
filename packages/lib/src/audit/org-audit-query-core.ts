/**
 * org-audit-query-core — the PURE half of the org audit log (Spec AUD-1, AUD-3): the event catalog by
 * category, filter validation, and CSV encoding.
 *
 * THE CATALOG IS THE QUERY'S BOUNDARY. An org's log is every chain row whose type is in this catalog and
 * whose details.orgId is the org. A filter can only narrow it: a type outside the catalog is refused, so
 * no parameter widens the query to the rest of the security log (logins, reads, other tenants' rows that
 * happen to carry an orgId-shaped detail).
 *
 * Org power used on a drive (ORG-4: opening a PRIVATE drive, or a lead action taken through org power) is
 * written by the permissions layer as `authz.access.granted` with details.orgId, so it is catalogued under
 * private_drive_access rather than renamed.
 *
 * CSV. RFC 4180 quoting, plus formula neutralization (OWASP "CSV injection"): a field starting with
 * = + - @, a tab or a carriage return gets a leading apostrophe, so a spreadsheet shows it as text.
 *
 * INVARIANT: zero I/O.
 */
import type { SecurityEventType } from '@pagespace/db/schema/security-audit';

type OrgEventType = Extract<SecurityEventType, `org.${string}`>;
export type OrgAuditCatalogType = OrgEventType | 'authz.access.granted';

export const ORG_AUDIT_CATEGORIES = {
  membership: [
    'org.created', 'org.updated', 'org.deleted', 'org.ownership.transferred', 'org.member.joined',
    'org.member.auto_joined', 'org.member.auto_join_refused', 'org.member.role_changed', 'org.member.removed', 'org.member.left',
    'org.member.suppression_cleared',
  ],
  seats: ['org.seat.auto_add_changed', 'org.seat.quantity_changed', 'org.seat.refused'],
  invites: ['org.invite.created', 'org.invite.resent', 'org.invite.revoked'],
  policies: ['org.policy.changed', 'org.policy.suspended', 'org.policy.restored', 'org.policy.blocked', 'org.guest.requested', 'org.guest.approved', 'org.guest.declined'],
  domains: ['org.domain.added', 'org.domain.verification_sent', 'org.domain.verified', 'org.domain.removed'],
  visibility: ['org.drive.visibility_changed', 'org.drive.join_requested', 'org.drive.join_approved', 'org.drive.join_declined', 'org.drive.join_withdrawn'],
  drive_moves: ['org.drive.created', 'org.drive.moved_in', 'org.drive.moved_out', 'org.drive.lead_changed'],
  private_drive_access: ['authz.access.granted'],
  wallets: ['org.wallet.allocation_changed', 'org.wallet.topped_up'],
  donations: ['org.wallet.donated'],
  billing: ['org.billing.subscription_changed', 'org.billing.pool_refilled'],
  // [D-OW-28] Compute handed to the drive lead when its creator leaves or loses the drive; a parked app taken back.
  compute: ['org.compute.reattributed', 'org.app.unparked'],
} as const satisfies Record<string, readonly OrgAuditCatalogType[]>;

export type OrgAuditCategory = keyof typeof ORG_AUDIT_CATEGORIES;

export const ORG_AUDIT_EVENT_TYPES: readonly OrgAuditCatalogType[] = Object.values(ORG_AUDIT_CATEGORIES).flat();

const CATEGORY_OF = new Map<string, OrgAuditCategory>(
  (Object.entries(ORG_AUDIT_CATEGORIES) as [OrgAuditCategory, readonly string[]][]).flatMap(([category, types]) =>
    types.map((type) => [type, category] as const),
  ),
);

/** The category a chain row belongs to, or null when it is not an org event. */
export function categoryOfOrgEvent(eventType: string): OrgAuditCategory | null {
  return CATEGORY_OF.get(eventType) ?? null;
}

export const isOrgAuditCatalogType = (value: string): value is OrgAuditCatalogType => CATEGORY_OF.has(value);

export const ORG_AUDIT_DEFAULT_LIMIT = 100;
export const ORG_AUDIT_MAX_LIMIT = 500;

export interface OrgAuditFilter {
  eventTypes: OrgAuditCatalogType[];
  driveId: string | null;
  from: Date | null;
  to: Date | null;
  limit: number;
  /** Keyset cursor: only rows whose chain_seq is below it (the previous page's last row). */
  before: number | null;
}

export type OrgAuditFilterInput = Partial<Record<'type' | 'category' | 'driveId' | 'from' | 'to' | 'limit' | 'before', string | null>>;

export type ParsedOrgAuditFilter = { ok: true; filter: OrgAuditFilter } | { ok: false; error: string };

const parseTime = (value: string): Date | null => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** Validate the query string of an org audit read; every field is optional. */
export function parseOrgAuditFilter(input: OrgAuditFilterInput): ParsedOrgAuditFilter {
  let eventTypes: OrgAuditCatalogType[] = [...ORG_AUDIT_EVENT_TYPES];
  if (input.category) {
    if (!(input.category in ORG_AUDIT_CATEGORIES)) return { ok: false, error: 'Unknown category' };
    eventTypes = [...ORG_AUDIT_CATEGORIES[input.category as OrgAuditCategory]];
  }
  if (input.type) {
    if (!isOrgAuditCatalogType(input.type)) return { ok: false, error: 'Unknown event type' };
    if (!eventTypes.includes(input.type)) return { ok: false, error: 'The event type is not in that category' };
    eventTypes = [input.type];
  }
  const from = input.from ? parseTime(input.from) : null;
  if (input.from && !from) return { ok: false, error: 'Invalid from' };
  const to = input.to ? parseTime(input.to) : null;
  if (input.to && !to) return { ok: false, error: 'Invalid to' };
  if (from && to && from.getTime() > to.getTime()) return { ok: false, error: 'from is after to' };
  let before: number | null = null;
  if (input.before) {
    if (!/^\d{1,15}$/.test(input.before)) return { ok: false, error: 'Invalid cursor' };
    before = Number(input.before);
  }
  let limit = ORG_AUDIT_DEFAULT_LIMIT;
  if (input.limit) {
    limit = /^\d{1,4}$/.test(input.limit) ? Number(input.limit) : 0;
    if (limit < 1 || limit > ORG_AUDIT_MAX_LIMIT) return { ok: false, error: `limit must be 1-${ORG_AUDIT_MAX_LIMIT}` };
  }
  return { ok: true, filter: { eventTypes, driveId: input.driveId || null, from, to, limit, before } };
}

/** What one org audit row shows. Ids only, plus a name the caller can already see (a current member). */
export interface OrgAuditEntry {
  timestamp: Date;
  category: OrgAuditCategory;
  eventType: string;
  actorId: string | null;
  actorName: string | null;
  resourceType: string | null;
  resourceId: string | null;
  driveId: string | null;
  details: Record<string, unknown>;
}

export const ORG_AUDIT_CSV_COLUMNS = ['timestamp', 'category', 'event_type', 'actor_id', 'actor_name', 'resource_type', 'resource_id', 'drive_id', 'details'] as const;

const FORMULA_LEAD = /^[=+\-@\t\r]/;

/** One CSV field: formula-neutralized, then quoted when it holds a separator, a quote or a line break. */
export function csvField(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  const safe = FORMULA_LEAD.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function orgAuditCsvRow(entry: Omit<OrgAuditEntry, 'category'> & { category: string }): string {
  return [
    entry.timestamp.toISOString(),
    entry.category,
    entry.eventType,
    entry.actorId,
    entry.actorName,
    entry.resourceType,
    entry.resourceId,
    entry.driveId,
    JSON.stringify(entry.details),
  ].map(csvField).join(',');
}

export const orgAuditCsvHeader = (): string => ORG_AUDIT_CSV_COLUMNS.join(',');
