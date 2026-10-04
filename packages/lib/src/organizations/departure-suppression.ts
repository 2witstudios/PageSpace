/**
 * [D-OW-27] Post-erasure suppression of departed members (SEC-1). A departed member's
 * org_member_departures rows cascade away with their account, so before the account goes the org keeps
 * only a KEYED blind index of their email: never the address, which cannot be recovered from it.
 * Verified-domain auto-join refuses a new account whose address matches; an org Admin can clear one.
 *
 * ONE NORMALIZATION, for suppression only: suppressionAddress (domains-core) trims, lowercases and drops
 * any `+subaddress`, so `dana+2@` is the mailbox `dana@`; dots are NOT folded. The same function keys the
 * write (at departure and, as a backstop, at account deletion), the auto-join check and the Admin clear.
 * The hash is the server's blind-index HMAC (computeBlindIndex, the users table's key) over a
 * suppression-only domain-separated value, so a suppression never equals a users.emailBidx.
 *
 * WRITTEN AT DEPARTURE: leaveOrganization records it in the departure's own transaction, for removed
 * and voluntary leavers alike, so a person who keeps their account cannot come back through a second
 * account on the same mailbox either. Residual (runbook): other subaddress delimiters and aliases.
 *
 * Without a usable index key (ENCRYPTION_KEY unset or short) nothing is recorded or matched: a record
 * that is not keyed would be a recoverable email, which this table must never hold.
 */
import { db } from '@pagespace/db/db';
import { and, eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { orgDepartureSuppressions, orgMemberDepartures } from '@pagespace/db/schema/organizations';
import { decryptUserRow, getUserIndexKey } from '../auth/user-repository';
import { computeBlindIndex } from '../encryption/blind-index';
import { suppressionAddress } from './domains-core';
import { recordOrgAuditEventAfterCommit } from '../audit/org-audit';
import { loggers } from '../logging/logger-config';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

const SUPPRESSION_DOMAIN = 'org-departure-suppression:v1:';

/** The keyed hash of an address's suppressed mailbox, or null when no index key is configured. */
export function departureSuppressionHash(email: string): string | null {
  const key = getUserIndexKey();
  return key ? computeBlindIndex(`${SUPPRESSION_DOMAIN}${suppressionAddress(email)}`, key) : null;
}

async function emailOf(executor: Executor, userId: string): Promise<string | null> {
  const [row] = await executor.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  if (!row) return null;
  return (await decryptUserRow(row)).email;
}

/**
 * Inside a departure's transaction (leaveOrganization): suppress the leaver's mailbox in that org, so no
 * account on it is auto-joined back, whichever account and whatever +subaddress.
 */
export async function recordDepartureSuppression(tx: Tx, orgId: string, userId: string): Promise<boolean> {
  const email = await emailOf(tx, userId);
  if (email === null) return false;
  const emailHash = departureSuppressionHash(email);
  if (emailHash === null) {
    loggers.security.error('[D-OW-27] no blind-index key: a departure suppression was not recorded', { orgId, userId });
    return false;
  }
  await tx.insert(orgDepartureSuppressions).values({ orgId, emailHash }).onConflictDoNothing({ target: [orgDepartureSuppressions.orgId, orgDepartureSuppressions.emailHash] });
  return true;
}

/**
 * Backstop inside the account deletion's transaction, BEFORE the user row is deleted (and after the
 * person has left every org): one suppression per org they ever departed. Departures already wrote
 * theirs; this is idempotent and covers an address changed since. Returns how many orgs it covers.
 */
export async function recordDepartureSuppressions(tx: Tx, userId: string): Promise<number> {
  const email = await emailOf(tx, userId);
  if (email === null) return 0;
  const emailHash = departureSuppressionHash(email);
  if (emailHash === null) {
    loggers.security.error('[D-OW-27] no blind-index key: a departed member\'s suppression was not recorded', { userId });
    return 0;
  }
  const departed = await tx.select({ orgId: orgMemberDepartures.orgId }).from(orgMemberDepartures).where(eq(orgMemberDepartures.userId, userId));
  if (departed.length === 0) return 0;
  await tx
    .insert(orgDepartureSuppressions)
    .values(departed.map(({ orgId }) => ({ orgId, emailHash })))
    .onConflictDoNothing({ target: [orgDepartureSuppressions.orgId, orgDepartureSuppressions.emailHash] });
  return departed.length;
}

/** Is this address suppressed in this org? */
export async function isDepartureSuppressed(executor: Executor, orgId: string, email: string): Promise<boolean> {
  const emailHash = departureSuppressionHash(email);
  if (emailHash === null) return false;
  const [hit] = await executor
    .select({ id: orgDepartureSuppressions.id })
    .from(orgDepartureSuppressions)
    .where(and(eq(orgDepartureSuppressions.orgId, orgId), eq(orgDepartureSuppressions.emailHash, emailHash)))
    .limit(1);
  return hit !== undefined;
}

/**
 * An org Admin clears a suppression by typing the address (the record cannot be listed by address: it
 * holds none). Audited without the address. True when a record was cleared.
 */
export async function clearDepartureSuppression(input: { orgId: string; email: string; actorId: string }): Promise<boolean> {
  const emailHash = departureSuppressionHash(input.email);
  if (emailHash === null) return false;
  const cleared = await db
    .delete(orgDepartureSuppressions)
    .where(and(eq(orgDepartureSuppressions.orgId, input.orgId), eq(orgDepartureSuppressions.emailHash, emailHash)))
    .returning({ id: orgDepartureSuppressions.id });
  if (cleared.length === 0) return false;
  await recordOrgAuditEventAfterCommit({
    orgId: input.orgId,
    eventType: 'org.member.suppression_cleared',
    actorId: input.actorId,
    resourceType: 'org_departure_suppression',
    resourceId: cleared[0].id,
  });
  return true;
}
