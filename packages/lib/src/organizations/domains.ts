/**
 * Verified email domains and auto-join — the IO around domains-core (Spec SEC-1, D-OW-1).
 *
 * CLAIM, PROVE, HOLD. An Owner or Admin adds a domain (a pending claim with its own DNS token), then
 * proves control by DNS TXT or by a link mailed to an administrative mailbox. Verification runs under
 * an advisory lock on the DOMAIN, so two orgs proving one domain at once serialize: the first holds it,
 * the second is refused. The partial unique key on verified domains is the backstop.
 *
 * AUTO-JOIN. Called after sign-in and after an address is verified, it is idempotent and cheap when
 * nothing applies (one indexed lookup). A join takes the same locks, in the same order, as accepting
 * an invite (address, org row, then the billing lock inside admitSeat), so it cannot race an invite
 * into a second seat, and it materializes the joiner on Open drives ONLY (syncOrgMemberAccess):
 * org membership is not drive membership, so a Restricted or Private drive stays closed.
 *
 * UN-VERIFY. Removing a claim stops future joins and removes nobody.
 */
import { Resolver } from 'node:dns/promises';
import { randomBytes } from 'node:crypto';
import { db } from '@pagespace/db/db';
import { and, asc, eq, gt, isNotNull, isNull, sql } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { orgDomains, orgInvitations, orgMemberDepartures, orgMembers, organizations, type OrgDomain } from '@pagespace/db/schema/organizations';
import { generateToken, hashToken } from '../auth/token-utils';
import { decryptUserRow } from '../auth/user-repository';
import { recordOrgAuditEventAfterCommit } from '../audit/org-audit';
import { loggers } from '../logging/logger-config';
import { isOrgGuest } from '../permissions/org-guest-footprint';
import { isDepartureSuppressed } from './departure-suppression';
import {
  publishOrgMembershipSyncEvents,
  syncOrgMemberAccess,
  type OrgMembershipSyncResult,
} from '../services/org-membership-sync';
import {
  DOMAIN_EMAIL_PROOF_TTL_MS,
  MAX_ORG_DOMAINS,
  adminMailboxAddress,
  decideAutoJoin,
  decideDomainVerification,
  isAuditedRejoinSkip,
  emailDomain,
  normalizeDomain,
  txtRecordsProve,
  dnsRecordName,
  type AutoJoinSkipReason,
  type DomainAdminMailbox,
} from './domains-core';
import { lockOrgInviteAddress } from './invitations';
import { ORGS_ENABLED } from './orgs-enabled';
import { isUniqueViolation, retryOnDeadlock } from './repository';
import { admitSeat, recordSeatAdmissionEvents, type SeatAdmission, type SeatBillingPort } from './seat-service';
import { checkOrgActive } from './status';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const DOMAIN_EMAIL_TOKEN_PREFIX = 'ps_orgdom';

/** What an Owner or Admin sees of a claim: never the mailed token's hash. */
export type PublicOrgDomain = Omit<OrgDomain, 'emailTokenHash'>;
const toPublic = ({ emailTokenHash: _hash, ...rest }: OrgDomain): PublicOrgDomain => rest;

export async function listOrgDomains(orgId: string): Promise<PublicOrgDomain[]> {
  // Every claim: addOrgDomain never lets an org hold more than the list returns.
  const rows = await db.select().from(orgDomains).where(eq(orgDomains.orgId, orgId)).orderBy(asc(orgDomains.createdAt)).limit(MAX_ORG_DOMAINS);
  return rows.map(toPublic);
}

/** Which org holds `domain` verified, read inside the caller's transaction. */
async function verifiedOwnerOf(executor: typeof db | Tx, domain: string): Promise<string | null> {
  const [row] = await executor
    .select({ orgId: orgDomains.orgId })
    .from(orgDomains)
    .where(and(eq(orgDomains.domain, domain), isNotNull(orgDomains.verifiedAt)))
    .limit(1);
  return row?.orgId ?? null;
}

async function lockDomain(tx: Tx, domain: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`org_domain:${domain}`}, 0))`);
}

export type AddOrgDomainResult =
  | { ok: true; domain: PublicOrgDomain }
  | { ok: false; status: 400; reason: 'invalid_domain' | 'public_email_domain' }
  | { ok: false; status: 409; reason: 'already_added' | 'claimed_by_another_org' | 'domain_limit_reached' };

/** A pending claim. Refused when another org already holds the domain verified (it could never be proven). */
export async function addOrgDomain(
  input: { orgId: string; domain: string; actorId: string },
  /** Test seam: runs inside the transaction after the org's claims are counted, before the insert. */
  hooks: { afterCount?: () => Promise<void> } = {},
): Promise<AddOrgDomainResult> {
  const normalized = normalizeDomain(input.domain);
  if (!normalized.ok) return { ok: false, status: 400, reason: normalized.reason };
  const { domain } = normalized;
  let row: OrgDomain;
  try {
    const result = await db.transaction(async (tx): Promise<OrgDomain | 'claimed' | 'full'> => {
      // The org's claim count is decided under a per-org lock (taken before the domain lock, the one
      // order), so two adds at once cannot both take the last place.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`org_domains_of:${input.orgId}`}, 0))`);
      const [{ held }] = await tx.select({ held: sql<number>`count(*)::int` }).from(orgDomains).where(eq(orgDomains.orgId, input.orgId));
      if (held >= MAX_ORG_DOMAINS) return 'full';
      await hooks.afterCount?.();
      await lockDomain(tx, domain);
      const owner = await verifiedOwnerOf(tx, domain);
      if (owner !== null && owner !== input.orgId) return 'claimed';
      const [inserted] = await tx
        .insert(orgDomains)
        .values({ orgId: input.orgId, domain, dnsToken: randomBytes(16).toString('hex'), createdBy: input.actorId })
        .returning();
      return inserted;
    });
    if (result === 'claimed') return { ok: false, status: 409, reason: 'claimed_by_another_org' };
    if (result === 'full') return { ok: false, status: 409, reason: 'domain_limit_reached' };
    row = result;
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, status: 409, reason: 'already_added' };
    throw error;
  }
  await recordOrgAuditEventAfterCommit({
    orgId: input.orgId,
    eventType: 'org.domain.added',
    actorId: input.actorId,
    resourceType: 'org_domain',
    resourceId: row.id,
    details: { domain },
  });
  return { ok: true, domain: toPublic(row) };
}

export type VerifyOrgDomainResult =
  | { ok: true; domain: PublicOrgDomain; alreadyVerified: boolean }
  | { ok: false; status: 404; reason: 'not_found' }
  | { ok: false; status: 409; reason: 'claimed_by_another_org' }
  | { ok: false; status: 422; reason: 'proof_not_found' | 'link_expired' };

/**
 * Seams for the concurrency tests only. `afterOwnerRead` runs inside the verification transaction,
 * after the domain's current owner is read and before the claim is written, so a test can hold one
 * verification open while another runs. `afterTokenLookup` runs between a mailed token's lookup and
 * the locked re-check, where a newer link can replace it. Production passes neither.
 */
export interface DomainVerificationHooks {
  afterOwnerRead?: (seen: { claimOrgId: string; verifiedByOrgId: string | null }) => Promise<void>;
  afterTokenLookup?: () => Promise<void>;
}

/** Make a claim the domain's verified owner, under the domain's lock, if the proof holds. */
async function verifyClaim(input: {
  claimId: string;
  orgId?: string;
  proven: (claim: OrgDomain) => boolean;
  method: 'dns' | 'email';
  actorId: string;
  now: Date;
}, hooks: DomainVerificationHooks = {}): Promise<VerifyOrgDomainResult> {
  let outcome: VerifyOrgDomainResult;
  try {
    outcome = await db.transaction(async (tx): Promise<VerifyOrgDomainResult> => {
      const [peek] = await tx.select({ domain: orgDomains.domain }).from(orgDomains).where(eq(orgDomains.id, input.claimId)).limit(1);
      if (!peek) return { ok: false, status: 404, reason: 'not_found' };
      await lockDomain(tx, peek.domain);
      const [claim] = await tx.select().from(orgDomains).where(eq(orgDomains.id, input.claimId)).for('update');
      if (!claim || (input.orgId !== undefined && claim.orgId !== input.orgId)) return { ok: false, status: 404, reason: 'not_found' };
      const verifiedByOrgId = await verifiedOwnerOf(tx, claim.domain);
      await hooks.afterOwnerRead?.({ claimOrgId: claim.orgId, verifiedByOrgId });
      const decision = decideDomainVerification({ claim, verifiedByOrgId, proven: input.proven(claim) });
      if (decision.action === 'already_verified') return { ok: true, domain: toPublic(claim), alreadyVerified: true };
      if (decision.action === 'refuse') {
        return decision.reason === 'claimed_by_another_org'
          ? { ok: false, status: 409, reason: decision.reason }
          : { ok: false, status: 422, reason: decision.reason };
      }
      const [verified] = await tx
        .update(orgDomains)
        .set({ verifiedAt: input.now, verifiedMethod: input.method, emailTokenHash: null, emailTokenExpiresAt: null })
        .where(eq(orgDomains.id, claim.id))
        .returning();
      return { ok: true, domain: toPublic(verified), alreadyVerified: false };
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, status: 409, reason: 'claimed_by_another_org' };
    throw error;
  }
  if (outcome.ok && !outcome.alreadyVerified) {
    await recordOrgAuditEventAfterCommit({
      orgId: outcome.domain.orgId,
      eventType: 'org.domain.verified',
      actorId: input.actorId,
      resourceType: 'org_domain',
      resourceId: outcome.domain.id,
      details: { domain: outcome.domain.domain, method: input.method },
    });
  }
  return outcome;
}

/** The DNS TXT lookup; an absent name or record is an empty answer, not an error. */
export type TxtResolver = (name: string) => Promise<string[][]>;

const NO_ANSWER = new Set(['ENOTFOUND', 'ENODATA', 'ESERVFAIL', 'ENOTIMP', 'EREFUSED', 'ETIMEOUT', 'ECONNREFUSED']);

export const resolveTxtRecords: TxtResolver = async (name) => {
  const resolver = new Resolver({ timeout: 5_000, tries: 2 });
  try {
    return await resolver.resolveTxt(name);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code && NO_ANSWER.has(code)) return [];
    throw error;
  }
};

/** Verify by DNS: the lookup happens BEFORE any lock is taken, so a slow resolver never holds one. */
export async function verifyOrgDomainByDns(input: {
  orgId: string;
  domainId: string;
  actorId: string;
  now: Date;
  resolveTxt?: TxtResolver;
}, hooks: DomainVerificationHooks = {}): Promise<VerifyOrgDomainResult> {
  const [claim] = await db
    .select({ domain: orgDomains.domain, dnsToken: orgDomains.dnsToken })
    .from(orgDomains)
    .where(and(eq(orgDomains.id, input.domainId), eq(orgDomains.orgId, input.orgId)))
    .limit(1);
  if (!claim) return { ok: false, status: 404, reason: 'not_found' };
  const records = await (input.resolveTxt ?? resolveTxtRecords)(dnsRecordName(claim.domain));
  return verifyClaim({
    claimId: input.domainId,
    orgId: input.orgId,
    // Judged against the token as stored at decision time, which a re-add can never change.
    proven: (locked) => txtRecordsProve(records, locked.dnsToken),
    method: 'dns',
    actorId: input.actorId,
    now: input.now,
  }, hooks);
}

/** Sends the proof link; a throw withdraws the stored token. */
export type DomainProofDelivery = (input: { to: string; domain: string; token: string; expiresAt: Date }) => Promise<void>;

export type SendDomainProofResult =
  | { ok: true; sentTo: string; expiresAt: Date }
  | { ok: false; status: 404; reason: 'not_found' }
  | { ok: false; status: 409; reason: 'already_verified' | 'claimed_by_another_org' }
  | { ok: false; status: 502; reason: 'delivery_failed'; cause: unknown };

/** Mail a one-use proof link to one of the domain's administrative mailboxes. A new link replaces the last. */
export async function sendDomainProofEmail(input: {
  orgId: string;
  domainId: string;
  mailbox: DomainAdminMailbox;
  actorId: string;
  now: Date;
  deliver: DomainProofDelivery;
}): Promise<SendDomainProofResult> {
  const { token, hash } = generateToken(DOMAIN_EMAIL_TOKEN_PREFIX);
  const expiresAt = new Date(input.now.getTime() + DOMAIN_EMAIL_PROOF_TTL_MS);
  const stored = await db.transaction(async (tx) => {
    const [claim] = await tx
      .select()
      .from(orgDomains)
      .where(and(eq(orgDomains.id, input.domainId), eq(orgDomains.orgId, input.orgId)))
      .for('update');
    if (!claim) return { ok: false, status: 404, reason: 'not_found' } as const;
    if (claim.verifiedAt !== null) return { ok: false, status: 409, reason: 'already_verified' } as const;
    const owner = await verifiedOwnerOf(tx, claim.domain);
    if (owner !== null) return { ok: false, status: 409, reason: 'claimed_by_another_org' } as const;
    const to = adminMailboxAddress(claim.domain, input.mailbox);
    await tx
      .update(orgDomains)
      .set({ emailTokenHash: hash, emailTokenExpiresAt: expiresAt, emailSentTo: to })
      .where(eq(orgDomains.id, claim.id));
    return { ok: true, claim, to } as const;
  });
  if (!stored.ok) return stored;
  try {
    await input.deliver({ to: stored.to, domain: stored.claim.domain, token, expiresAt });
  } catch (cause) {
    await db
      .update(orgDomains)
      .set({ emailTokenHash: null, emailTokenExpiresAt: null })
      .where(and(eq(orgDomains.id, stored.claim.id), eq(orgDomains.emailTokenHash, hash)));
    return { ok: false, status: 502, reason: 'delivery_failed', cause };
  }
  await recordOrgAuditEventAfterCommit({
    orgId: input.orgId,
    eventType: 'org.domain.verification_sent',
    actorId: input.actorId,
    resourceType: 'org_domain',
    resourceId: stored.claim.id,
    details: { domain: stored.claim.domain, mailbox: input.mailbox },
  });
  return { ok: true, sentTo: stored.to, expiresAt };
}

/**
 * The mailed link: whoever holds the administrative mailbox confirms it from any signed-in account (the
 * token is the proof; the account is who the audit names). The token is one-use (cleared on success)
 * and expires.
 */
export async function confirmDomainProofEmail(
  input: { token: string; actorId: string; now: Date },
  hooks: DomainVerificationHooks = {},
): Promise<VerifyOrgDomainResult> {
  const tokenHash = hashToken(input.token);
  const [claim] = await db
    .select({ id: orgDomains.id, expiresAt: orgDomains.emailTokenExpiresAt })
    .from(orgDomains)
    .where(eq(orgDomains.emailTokenHash, tokenHash))
    .limit(1);
  if (!claim) return { ok: false, status: 404, reason: 'not_found' };
  if (!claim.expiresAt || claim.expiresAt.getTime() <= input.now.getTime()) return { ok: false, status: 422, reason: 'link_expired' };
  await hooks.afterTokenLookup?.();
  return verifyClaim({
    claimId: claim.id,
    // Re-checked under the lock: the token must still be this claim's live token.
    proven: (locked) =>
      locked.emailTokenHash === tokenHash &&
      locked.emailTokenExpiresAt !== null &&
      locked.emailTokenExpiresAt.getTime() > input.now.getTime(),
    method: 'email',
    actorId: input.actorId,
    now: input.now,
  }, hooks);
}

/** Un-verify and forget a claim. Stops future auto-joins; nobody already in is removed. */
export async function removeOrgDomain(input: { orgId: string; domainId: string; actorId: string }): Promise<boolean> {
  const [removed] = await db
    .delete(orgDomains)
    .where(and(eq(orgDomains.id, input.domainId), eq(orgDomains.orgId, input.orgId)))
    .returning();
  if (!removed) return false;
  await recordOrgAuditEventAfterCommit({
    orgId: input.orgId,
    eventType: 'org.domain.removed',
    actorId: input.actorId,
    resourceType: 'org_domain',
    resourceId: removed.id,
    details: { domain: removed.domain, wasVerified: removed.verifiedAt !== null },
  });
  return true;
}

export type AutoJoinResult =
  | { kind: 'joined'; orgId: string; seatRaised: boolean }
  | { kind: 'skipped'; reason: AutoJoinSkipReason | 'orgs_disabled' | 'no_verified_domain' | 'user_not_found' }
  | { kind: 'refused'; orgId: string; reason: 'org_lapsed' }
  | { kind: 'refused'; orgId: string; reason: 'seats_full'; message: string };

export interface AutoJoinDeps {
  syncMemberAccess: typeof syncOrgMemberAccess;
  publishSyncEvents: (result: OrgMembershipSyncResult) => Promise<void>;
}

const autoJoinDeps: AutoJoinDeps = {
  syncMemberAccess: syncOrgMemberAccess,
  publishSyncEvents: (result) => publishOrgMembershipSyncEvents(result),
};

type JoinOutcome =
  | {
    result: AutoJoinResult;
    sync: OrgMembershipSyncResult | null;
    domain: string;
    /** [D-OW-27] Set when a departed person's re-join was turned away: the org whose log records it. */
    rejoinOrgId?: string | null;
  };

/**
 * SEC-1: join this person to the org that holds their address's domain verified, if they qualify and a
 * seat can be granted. Never throws for a refusal; the result says what happened.
 */
export async function autoJoinVerifiedDomainOrg(
  input: { userId: string; now: Date; seatBilling?: SeatBillingPort },
  deps: AutoJoinDeps = autoJoinDeps,
): Promise<AutoJoinResult> {
  if (!ORGS_ENABLED) return { kind: 'skipped', reason: 'orgs_disabled' };
  const [userRow] = await db
    .select({ email: users.email, emailVerified: users.emailVerified, createdAt: users.createdAt })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);
  if (!userRow) return { kind: 'skipped', reason: 'user_not_found' };
  if (!userRow.emailVerified) return { kind: 'skipped', reason: 'email_not_verified' };
  const { email } = await decryptUserRow(userRow);
  const domain = emailDomain(email);
  if (domain === null) return { kind: 'skipped', reason: 'no_verified_domain' };
  const [verified] = await db
    .select({ orgId: orgDomains.orgId })
    .from(orgDomains)
    .where(and(eq(orgDomains.domain, domain), isNotNull(orgDomains.verifiedAt)))
    .limit(1);
  if (!verified) return { kind: 'skipped', reason: 'no_verified_domain' };
  const orgId = verified.orgId;

  let admission = null as SeatAdmission | null;
  const outcome = await retryOnDeadlock(() => db.transaction(async (tx): Promise<JoinOutcome> => {
    // The invite-acceptance lock order: address, org row, then (inside admitSeat) billing.
    await lockOrgInviteAddress(tx, orgId, email);
    await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, orgId)).for('update');
    // Re-read under the locks: the claim may have been removed since the lookup above.
    const [claim] = await tx
      .select({ verifiedAt: orgDomains.verifiedAt })
      .from(orgDomains)
      .where(and(eq(orgDomains.orgId, orgId), eq(orgDomains.domain, domain), isNotNull(orgDomains.verifiedAt)))
      .limit(1);
    const [member] = await tx
      .select({ id: orgMembers.id })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, input.userId)))
      .limit(1);
    // Written by leaveOrganization for every way a membership ends (removed, left, account gone).
    const [departed] = await tx
      .select({ id: orgMemberDepartures.id })
      .from(orgMemberDepartures)
      .where(and(eq(orgMemberDepartures.orgId, orgId), eq(orgMemberDepartures.userId, input.userId)))
      .limit(1);
    const [openInvite] = await tx
      .select({ id: orgInvitations.id })
      .from(orgInvitations)
      .where(and(
        eq(orgInvitations.orgId, orgId),
        isNull(orgInvitations.acceptedAt),
        gt(orgInvitations.expiresAt, input.now),
        sql`lower(${orgInvitations.email}) = lower(${email})`,
      ))
      .limit(1);
    const isMember = member !== undefined;
    const decision = decideAutoJoin({
      emailVerified: true,
      userCreatedAt: userRow.createdAt,
      domainVerifiedAt: claim?.verifiedAt ?? null,
      isMember,
      previouslyDeparted: departed !== undefined,
      departureSuppressed: await isDepartureSuppressed(tx, orgId, email),
      hasOpenInvite: openInvite !== undefined,
      isOrgGuest: isMember ? false : await isOrgGuest(orgId, input.userId, tx),
      orgActive: (await checkOrgActive(orgId, { executor: tx, now: input.now })).ok,
    });
    if (decision.action === 'skip') {
      return { result: { kind: 'skipped', reason: decision.reason }, sync: null, domain, rejoinOrgId: isAuditedRejoinSkip(decision.reason) ? orgId : null };
    }
    if (decision.action === 'refuse') return { result: { kind: 'refused', orgId, reason: decision.reason }, sync: null, domain };

    // The joiner takes a seat like an invite does; no inviter, so the refusal reads for a member.
    const seat: SeatAdmission = await admitSeat(tx, { orgId, actorRole: 'MEMBER' }, input.seatBilling);
    admission = seat;
    if (!seat.ok) return { result: { kind: 'refused', orgId, reason: 'seats_full', message: seat.message }, sync: null, domain };

    await tx.insert(orgMembers).values({ orgId, userId: input.userId, role: 'MEMBER' });
    const sync = await deps.syncMemberAccess(orgId, input.userId, { tx });
    return { result: { kind: 'joined', orgId, seatRaised: seat.raised }, sync, domain };
  }));

  if (outcome.sync) await deps.publishSyncEvents(outcome.sync);
  const { result } = outcome;
  if (result.kind === 'joined') {
    if (admission) await recordSeatAdmissionEvents({ orgId: result.orgId, actorId: input.userId, admission, operation: 'auto_join' });
    await recordOrgAuditEventAfterCommit({
      orgId: result.orgId,
      eventType: 'org.member.auto_joined',
      actorId: input.userId,
      resourceType: 'user',
      resourceId: input.userId,
      details: { domain: outcome.domain, role: 'MEMBER', seatRaised: result.seatRaised },
    });
  } else if (result.kind === 'skipped' && outcome.rejoinOrgId) {
    // [D-OW-27] A departed person tried to come back and was turned away: the Owner sees that someone tried, by
    // account id and domain, never by address (a suppression holds only a keyed hash of it).
    await recordOrgAuditEventAfterCommit({
      orgId: outcome.rejoinOrgId,
      eventType: 'org.member.auto_join_refused',
      actorId: input.userId,
      resourceType: 'user',
      resourceId: input.userId,
      details: { domain: outcome.domain, reason: result.reason },
    });
  } else if (result.kind === 'refused') {
    // The Owner finds a refused join in the audit trail; the person simply is not added.
    await recordOrgAuditEventAfterCommit({
      orgId: result.orgId,
      eventType: 'org.member.auto_join_refused',
      actorId: input.userId,
      resourceType: 'user',
      resourceId: input.userId,
      details: { domain: outcome.domain, reason: result.reason },
    });
    loggers.api.info('verified-domain auto-join refused', { orgId: result.orgId, reason: result.reason });
  }
  return result;
}
