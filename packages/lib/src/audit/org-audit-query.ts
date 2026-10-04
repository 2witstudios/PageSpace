/**
 * The org audit log read (Spec AUD-2, AUD-3): one org's rows of the EXISTING security audit chain, filtered
 * by type, drive and time, newest first, paged by chain_seq. No new table and no second chain.
 *
 * SCOPE. Every query is pinned to `details->>'orgId' = <the caller's org>` and to the org catalog's event
 * types (org-audit-query-core). The orgId comes from the authorized route, never from the filter, so an
 * Admin of org A cannot read org B's rows by passing B's drive or a cursor: those only narrow A's rows.
 *
 * WHAT A ROW SHOWS. Ids, the category, the event's own details (ids and counts by construction — see
 * org-audit.ts) without the org dimension, and a display name only for actors who are CURRENT members of
 * the org (an Owner or Admin can already see the member list). Never an IP address or user agent.
 *
 * The rows are read through the resolved audit binding, the same store the chain writes to and the
 * verifier reads (the Admin PG when dedicated).
 */
import { and, desc, eq, gte, inArray, lt, lte, or, sql } from '@pagespace/db/operators';
import { db } from '@pagespace/db/db';
import { users } from '@pagespace/db/schema/auth';
import { orgMembers } from '@pagespace/db/schema/organizations';
import { securityAuditLog } from '@pagespace/db/schema/security-audit';
import { decryptUserRow } from '../auth/user-repository';
import { resolveAuditDbBinding } from './audit-db-binding';
import type { SecurityAuditDatabase } from './security-audit-repository';
import {
  ORG_AUDIT_MAX_LIMIT,
  categoryOfOrgEvent,
  orgAuditCsvHeader,
  orgAuditCsvRow,
  type OrgAuditEntry,
  type OrgAuditFilter,
} from './org-audit-query-core';

export interface OrgAuditPage {
  entries: OrgAuditEntry[];
  /** Pass as `before` for the next page; null on the last page. */
  nextCursor: number | null;
}

export interface OrgAuditQueryDeps {
  auditDb?: SecurityAuditDatabase;
}

interface RawOrgAuditRow {
  chainSeq: number;
  timestamp: Date;
  eventType: string;
  userId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  details: Record<string, unknown> | null;
}

async function readRows(orgId: string, filter: OrgAuditFilter, auditDb: SecurityAuditDatabase): Promise<RawOrgAuditRow[]> {
  const conditions = [
    sql`${securityAuditLog.details}->>'orgId' = ${orgId}`,
    inArray(securityAuditLog.eventType, filter.eventTypes),
  ];
  if (filter.driveId) {
    // An org event names its drive in details.driveId; an org-power access row names it as the resource.
    conditions.push(or(
      sql`${securityAuditLog.details}->>'driveId' = ${filter.driveId}`,
      and(eq(securityAuditLog.resourceType, 'drive'), eq(securityAuditLog.resourceId, filter.driveId)),
    )!);
  }
  if (filter.from) conditions.push(gte(securityAuditLog.timestamp, filter.from));
  if (filter.to) conditions.push(lte(securityAuditLog.timestamp, filter.to));
  if (filter.before !== null) conditions.push(lt(securityAuditLog.chainSeq, filter.before));
  return auditDb
    .select({
      chainSeq: securityAuditLog.chainSeq,
      timestamp: securityAuditLog.timestamp,
      eventType: securityAuditLog.eventType,
      userId: securityAuditLog.userId,
      resourceType: securityAuditLog.resourceType,
      resourceId: securityAuditLog.resourceId,
      details: securityAuditLog.details,
    })
    .from(securityAuditLog)
    .where(and(...conditions))
    .orderBy(desc(securityAuditLog.chainSeq))
    .limit(Math.min(filter.limit, ORG_AUDIT_MAX_LIMIT) + 1);
}

/** Display names for the actors that are current members of the org; everyone else stays an id. */
async function memberNames(orgId: string, actorIds: string[]): Promise<Map<string, string>> {
  if (actorIds.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, name: users.name })
    .from(orgMembers)
    .innerJoin(users, eq(users.id, orgMembers.userId))
    .where(and(eq(orgMembers.orgId, orgId), inArray(orgMembers.userId, actorIds)));
  const names = new Map<string, string>();
  for (const row of rows) {
    const { name } = await decryptUserRow(row);
    if (name) names.set(row.id, name);
  }
  return names;
}

function toEntry(row: RawOrgAuditRow, names: Map<string, string>): OrgAuditEntry | null {
  const category = categoryOfOrgEvent(row.eventType);
  if (category === null) return null;
  const { orgId: _orgId, driveId, ...details } = row.details ?? {};
  const resourceDrive = row.resourceType === 'drive' ? row.resourceId : null;
  return {
    timestamp: row.timestamp,
    category,
    eventType: row.eventType,
    actorId: row.userId,
    actorName: row.userId ? names.get(row.userId) ?? null : null,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    driveId: typeof driveId === 'string' ? driveId : resourceDrive,
    details,
  };
}

/** One page of an org's audit log, newest first. */
export async function queryOrgAuditEvents(orgId: string, filter: OrgAuditFilter, deps: OrgAuditQueryDeps = {}): Promise<OrgAuditPage> {
  const auditDb = deps.auditDb ?? resolveAuditDbBinding().db;
  const rows = await readRows(orgId, filter, auditDb);
  const page = rows.slice(0, filter.limit);
  const names = await memberNames(orgId, [...new Set(page.map((r) => r.userId).filter((id): id is string => id !== null))]);
  return {
    entries: page.map((row) => toEntry(row, names)).filter((e): e is OrgAuditEntry => e !== null),
    nextCursor: rows.length > filter.limit ? page[page.length - 1].chainSeq : null,
  };
}

/** The most rows one export may hold; a larger log is exported in time windows. */
export const ORG_AUDIT_EXPORT_MAX_ROWS = 50_000;
const EXPORT_CHUNK = ORG_AUDIT_MAX_LIMIT;

/**
 * The CSV export: the header, then the log in chunks of ORG_AUDIT_MAX_LIMIT rows read by keyset, so no
 * chunk holds more than one page in memory. Ends early at ORG_AUDIT_EXPORT_MAX_ROWS with a final
 * `truncated` row, so a reader can never mistake a cut-off file for the whole log.
 */
export async function* exportOrgAuditCsv(
  orgId: string,
  filter: Omit<OrgAuditFilter, 'limit' | 'before'>,
  deps: OrgAuditQueryDeps = {},
): AsyncGenerator<string> {
  yield `${orgAuditCsvHeader()}\r\n`;
  let before: number | null = null;
  let written = 0;
  for (;;) {
    const page = await queryOrgAuditEvents(orgId, { ...filter, limit: EXPORT_CHUNK, before }, deps);
    const room = ORG_AUDIT_EXPORT_MAX_ROWS - written;
    const take = page.entries.slice(0, room);
    if (take.length > 0) yield take.map((entry) => `${orgAuditCsvRow(entry)}\r\n`).join('');
    written += take.length;
    if (page.nextCursor === null) return;
    if (written >= ORG_AUDIT_EXPORT_MAX_ROWS) {
      yield `${orgAuditCsvRow({ timestamp: new Date(0), category: 'export', eventType: 'truncated', actorId: null, actorName: null, resourceType: null, resourceId: null, driveId: null, details: { limit: ORG_AUDIT_EXPORT_MAX_ROWS, hint: 'narrow the time window' } })}\r\n`;
      return;
    }
    before = page.nextCursor;
  }
}
