/**
 * AUD-1's "Done means": every mutation of Phases 1-4 writes its org event. This suite runs the Northwind
 * story through the REAL lib services against a real Postgres and the REAL security audit chain, then
 * reads the org's log back through queryOrgAuditEvents and asserts a row for every event type the lib
 * emits. The few types written only by apps/web (a route or the Stripe webhook) are named, with the file
 * that writes them, in WEB_EMITTED, and the static half below proves each such file writes its type. The
 * two lists together must equal the catalog: a new catalog type with no emitter fails here.
 *
 * Audit rows are never deleted (they are links in the hash chain); every org, drive, wallet and user row
 * is, children before parents, users last.
 *
 * Run via:
 *   bun run --filter '@pagespace/lib' test:integration -- src/audit/__tests__/org-audit-coverage.integration.test.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { orgInvitations, orgMembers, orgSubscriptions, organizations } from '@pagespace/db/schema/organizations';
import { wallets } from '@pagespace/db/schema/wallets';
import { resetAuditDbBindingForTests } from '../audit-db-binding';
import { resetDefaultSecurityAuditForTests } from '../security-audit';
import { ORG_AUDIT_EVENT_TYPES, parseOrgAuditFilter, type OrgAuditCatalogType } from '../org-audit-query-core';
import { queryOrgAuditEvents } from '../org-audit-query';
import { verifySecurityAuditChain } from '../security-audit-chain-verifier';
import { EnforcedAuthContext } from '../../permissions/enforced-context';
import type { SessionClaims } from '../../auth/session-service';
import { createDriveShareLink, redeemDriveShareLink } from '../../permissions/share-link-service';
import { getUserDriveAccess } from '../../permissions/permissions';
import { createOrganization, updateOrganization } from '../../organizations/repository';
import { acceptInvitation, createOrRotateInvitation, resendInvitation, revokeInvitation } from '../../organizations/invitations';
import { changeMemberRole, removeMember, transferOwnership } from '../../organizations/membership';
import { leaveOrganization } from '../../organizations/leave';
import { deleteOrganization } from '../../organizations/deletion';
import { setSeatAutoAdd, type SeatBillingPort } from '../../organizations/seat-service';
import { updateOrgPolicies } from '../../organizations/policies';
import { addOrgDomain, autoJoinVerifiedDomainOrg, removeOrgDomain, sendDomainProofEmail, verifyOrgDomainByDns } from '../../organizations/domains';
import { dnsRecordName, dnsRecordValue } from '../../organizations/domains-core';
import { changeDriveVisibility, changeOrgDriveLead, createOrgDrive, moveDriveOutOfOrg, moveDriveToOrg, type OrgDriveServiceDeps } from '../../services/org-drive-service';
import { orgDriveServiceDeps } from '../../services/org-drive-service-deps';
import { answerDriveJoinRequest, requestToJoinDrive, withdrawDriveJoinRequest } from '../../services/drive-join-request-service';
import { createDriveWallet, donateToDrive, topUpDriveWallet, updateDriveWallet } from '../../services/drive-wallet-service';
import { applyOrgPoolRefill } from '../../billing/wallet-funding-shell';
import { hashToken } from '../../auth/token-utils';
import { accountRepository } from '../../repositories/account-repository';
import { clearDepartureSuppression } from '../../organizations/departure-suppression';
import { recordComputeReattributions } from '../../organizations/leave';
import { deleteOwnerLeftAutomation, reassignOwnerLeftAutomation } from '../../organizations/automation-ownership';
import { workflows } from '@pagespace/db/schema/workflows';
import { defaultAppUnparkDeps, unparkPublishedApp } from '../../services/app-hosting/app-unpark';
import { driveEnvs } from '@pagespace/db/schema/drive-envs';
import { publishedApps } from '@pagespace/db/schema/published-apps';

vi.mock('../../organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));

/** Types only apps/web writes, with the file that writes each (checked statically below). */
const WEB_EMITTED: Partial<Record<OrgAuditCatalogType, string[]>> = {
  'org.guest.approved': ['apps/web/src/app/api/orgs/[orgId]/guest-approvals/[holdId]/route.ts'],
  'org.guest.declined': ['apps/web/src/app/api/orgs/[orgId]/guest-approvals/[holdId]/route.ts'],
  'org.billing.subscription_changed': [
    'apps/web/src/lib/org-billing/org-subscription.ts',
    'apps/web/src/app/api/stripe/webhook/org-handlers.ts',
  ],
};

const REPO = path.resolve(__dirname, '../../../../..');
const AUDIT_ENV = ['ADMIN_DATABASE_URL', 'ADMIN_DB_BREAK_GLASS', 'AUDIT_TRUST_PLANE_REQUIRED'] as const;
const savedEnv = new Map<string, string | undefined>();
const originalMode = process.env.DEPLOYMENT_MODE;
const resetAudit = () => {
  resetAuditDbBindingForTests();
  resetDefaultSecurityAuditForTests();
};

const created = { users: [] as string[], drives: [] as string[], orgs: [] as string[] };

class FakeSeatStripe implements SeatBillingPort {
  async setSeatQuantity(params: { quantity: number }) {
    return { quantity: params.quantity };
  }
  async readSeatQuantity() {
    return 0;
  }
}

const ctxFor = (userId: string): EnforcedAuthContext => {
  const claims: SessionClaims = {
    sessionId: 'sess', userId, userRole: 'user', tokenVersion: 1, adminRoleVersion: 0, type: 'user', scopes: ['*'],
    expiresAt: new Date(Date.now() + 3_600_000), driveId: undefined,
  };
  return EnforcedAuthContext.fromSession(claims);
};

// The realtime publish is not what this suite is about.
const deps: OrgDriveServiceDeps = { ...orgDriveServiceDeps, syncOrgMembership: async () => async () => {} };
const deliver = async () => {};

async function person(name: string, email?: string) {
  const user = await factories.createUser({ name, subscriptionTier: 'free', emailVerified: new Date(), ...(email ? { email } : {}) });
  created.users.push(user.id);
  return user;
}

const typesFor = async (orgId: string): Promise<Set<string>> => {
  const parsed = parseOrgAuditFilter({ limit: '500' });
  if (!parsed.ok) throw new Error(parsed.error);
  const page = await queryOrgAuditEvents(orgId, parsed.filter);
  return new Set(page.entries.map((e) => e.eventType));
};

describe('every org mutation writes its event', () => {
  let startedAt: Date;

  beforeAll(async () => {
    try {
      await db.select({ id: organizations.id }).from(organizations).limit(1);
    } catch (error) {
      requireDb('org-audit-coverage.integration.test.ts', error);
    }
    for (const key of AUDIT_ENV) {
      savedEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    process.env.DEPLOYMENT_MODE = 'cloud';
    resetAudit();
    startedAt = new Date(Date.now() - 1000);
  });

  afterAll(async () => {
    const orgIds = created.orgs.splice(0);
    if (orgIds.length > 0) {
      await db.delete(wallets).where(inArray(wallets.parentWalletId, db.select({ id: wallets.id }).from(wallets).where(inArray(wallets.orgId, orgIds))));
      await db.delete(wallets).where(inArray(wallets.orgId, orgIds));
      const orgDriveIds = (await db.select({ id: drives.id }).from(drives).where(inArray(drives.orgId, orgIds))).map((d) => d.id);
      created.drives.push(...orgDriveIds);
    }
    const driveIds = [...new Set(created.drives.splice(0))];
    if (driveIds.length > 0) await db.delete(drives).where(inArray(drives.id, driveIds));
    if (orgIds.length > 0) {
      await db.delete(orgInvitations).where(inArray(orgInvitations.orgId, orgIds));
      await db.delete(orgMembers).where(inArray(orgMembers.orgId, orgIds));
      await db.delete(orgSubscriptions).where(inArray(orgSubscriptions.orgId, orgIds));
      await db.delete(organizations).where(inArray(organizations.id, orgIds));
    }
    const userIds = created.users.splice(0);
    if (userIds.length > 0) {
      await db.delete(wallets).where(inArray(wallets.userId, userIds));
      await db.delete(drives).where(inArray(drives.ownerId, userIds));
      await db.delete(users).where(inArray(users.id, userIds));
    }
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (originalMode === undefined) delete process.env.DEPLOYMENT_MODE;
    else process.env.DEPLOYMENT_MODE = originalMode;
    resetAudit();
  });

  it('AUD-1 (partial) AUD-2 (partial) the Northwind story through the real services leaves a row of every lib-emitted type, under the org, on a chain that still verifies', async () => {
    const domain = `northwind-${createId()}.com`;
    const jono = await person('Jono');
    const priya = await person('Priya Nair');
    const marcus = await person('Marcus Oyelaran');
    const lena = await person('Lena Schulz');
    const dana = await person('Dana Kim');
    const chris = await person('Chris Rowe');
    const tomasEmail = `tomas-${createId()}@invitee.test`;
    const tomas = await person('Tomás Alvarez', tomasEmail);

    // ── membership: create, update ────────────────────────────────────────────
    const org = await createOrganization({ name: 'Northwind Labs', slug: `northwind-${createId()}`, ownerId: jono.id });
    if (!org.ok) throw new Error(org.reason);
    const orgId = org.organization.id;
    created.orgs.push(orgId);
    expect((await updateOrganization(orgId, { name: 'Northwind' }, jono.id)).ok).toBe(true);
    await db.insert(orgMembers).values([
      { orgId, userId: priya.id, role: 'ADMIN' },
      { orgId, userId: marcus.id, role: 'MEMBER' },
      { orgId, userId: lena.id, role: 'MEMBER' },
      { orgId, userId: dana.id, role: 'MEMBER' },
    ]);
    await db.insert(orgSubscriptions).values({
      orgId,
      stripeSubscriptionId: `sub_${createId()}`,
      stripeBasePriceId: 'price_base_test',
      stripeBaseItemId: `si_${createId()}`,
      stripeSeatPriceId: 'price_seat_test',
      stripeSeatItemId: `si_${createId()}`,
      status: 'active',
      currentPeriodStart: new Date(Date.now() - 86_400_000),
      currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
    });

    // ── seats and invites: five held, auto-add on raises, off refuses; resend, accept, revoke ─────────
    expect(await setSeatAutoAdd(orgId, true, jono.id)).toBe(true);
    const stripe = new FakeSeatStripe();
    const tokens: string[] = [];
    const invited = await createOrRotateInvitation({
      orgId, email: tomasEmail, role: 'MEMBER', invitedBy: jono.id, actorRole: 'OWNER', now: new Date(), seatBilling: stripe,
      deliver: async (_i, token) => { tokens.push(token); },
    });
    if (!invited.ok) throw new Error(`invite: ${invited.reason}`);
    expect(await setSeatAutoAdd(orgId, false, jono.id)).toBe(true);
    const refused = await createOrRotateInvitation({ orgId, email: `x-${createId()}@invitee.test`, role: 'MEMBER', invitedBy: jono.id, actorRole: 'OWNER', now: new Date(), deliver });
    expect(refused).toMatchObject({ ok: false, reason: 'seats_full' });
    const resent = await resendInvitation({ orgId, invitationId: invited.invitation.id, actorRole: 'OWNER', actorId: jono.id, now: new Date(), deliver: async (_i, token) => { tokens.push(token); } });
    expect(resent.ok).toBe(true);
    expect(await acceptInvitation({ token: tokens[tokens.length - 1], userId: tomas.id, now: new Date() })).toMatchObject({ ok: true, joined: true });
    const [stale] = await db.insert(orgInvitations).values({ orgId, email: `y-${createId()}@invitee.test`, role: 'MEMBER', tokenHash: hashToken(createId()), invitedBy: jono.id, expiresAt: new Date(Date.now() + 86_400_000) }).returning();
    expect(await revokeInvitation({ orgId, invitationId: stale.id, actorId: jono.id })).toBe(true);
    expect((await changeMemberRole({ orgId, actorId: jono.id, targetId: marcus.id, newRole: 'ADMIN' })).ok).toBe(true);

    // ── drives: create, visibility, join requests, move in and out, lead ──────────
    const product = await createOrgDrive(lena.id, { name: 'Product', orgId }, deps);
    if (!product.ok) throw new Error('create drive');
    const productId = product.drive.id;
    created.drives.push(productId);
    expect((await changeDriveVisibility(lena.id, productId, { orgVisibility: 'RESTRICTED' }, deps)).ok).toBe(true);
    const ask1 = await requestToJoinDrive(dana.id, productId);
    if (!ask1.ok) throw new Error('join request');
    expect((await answerDriveJoinRequest(lena.id, productId, ask1.request.id, 'deny')).ok).toBe(true);
    const ask2 = await requestToJoinDrive(dana.id, productId);
    if (!ask2.ok) throw new Error('join request');
    expect((await withdrawDriveJoinRequest(dana.id, productId, ask2.request.id)).ok).toBe(true);
    const ask3 = await requestToJoinDrive(dana.id, productId);
    if (!ask3.ok) throw new Error('join request');
    expect((await answerDriveJoinRequest(lena.id, productId, ask3.request.id, 'approve')).ok).toBe(true);
    const notes = await factories.createDrive(lena.id, { name: 'Lena Notes', slug: `notes-${createId()}` });
    created.drives.push(notes.id);
    expect((await moveDriveToOrg(lena.id, notes.id, { orgId }, deps)).ok).toBe(true);
    expect((await moveDriveOutOfOrg(jono.id, notes.id, { implicitMembers: 'remove' }, deps)).ok).toBe(true);
    expect((await changeOrgDriveLead(lena.id, productId, { newLeadId: marcus.id }, deps)).ok).toBe(true);

    // ── admin access to a Private drive (ORG-4) ──────────────────────────────────
    const finance = await factories.createDrive(lena.id, { name: 'Finance', slug: `finance-${createId()}`, orgId, orgVisibility: 'PRIVATE' });
    created.drives.push(finance.id);
    expect(await getUserDriveAccess(priya.id, finance.id)).toBe(true);

    // ── policies, and a guest held by them ───────────────────────────────────────
    const link = await createDriveShareLink(ctxFor(marcus.id), productId, {});
    if (!link.ok) throw new Error('share link');
    expect((await updateOrgPolicies({ orgId, actorId: jono.id, patch: { publicShareLinks: false } })).ok).toBe(true);
    expect((await updateOrgPolicies({ orgId, actorId: jono.id, patch: { publicShareLinks: true, guests: 'approve' } })).ok).toBe(true);
    // POL-1: a page agent on a model the org then stops allowing is listed as blocked (org.policy.blocked).
    await factories.createPage(productId, { type: 'AI_CHAT', aiProvider: 'openai', aiModel: 'gpt-old' });
    expect((await updateOrgPolicies({ orgId, actorId: jono.id, patch: { modelAllowlist: ['gpt-new'] } })).ok).toBe(true);
    expect(await redeemDriveShareLink(ctxFor(chris.id), link.data.rawToken)).toMatchObject({ ok: false, error: 'PENDING_APPROVAL' });

    // ── compute (D-OW-28): an env handed to the lead, a parked app taken back ───────
    const envId = createId();
    await db.insert(driveEnvs).values({ id: envId, driveId: productId, name: `env-${envId}`, createdBy: tomas.id, costOwnerId: null, sandboxId: `sbx-${envId}` });
    await recordComputeReattributions([{ orgId, kind: 'drive_env', id: envId, driveId: productId, formerCostOwnerId: tomas.id }], jono.id);
    const appId = createId();
    await db.insert(publishedApps).values({
      id: appId, envId, driveId: productId, ownerId: tomas.id, costOwnerId: tomas.id, flyAppName: `pgs-${appId}`, networkName: 'published-apps',
      subdomain: `cov-${appId}`.toLowerCase(), machineId: `m-${appId}`, imageDigest: 'sha256:abc', status: 'parked', lastError: 'parked: test', tier: 'metered', updatedAt: new Date(),
    });
    expect(await unparkPublishedApp({ publishedAppId: appId, actorId: jono.id }, {
      ...defaultAppUnparkDeps,
      isEnabled: () => true,
      // The real payer resolution; the wallet gate is not what this story audits, so it admits the wake.
      billing: { ...defaultAppUnparkDeps.billing, gate: async () => ({ allowed: true }) },
    })).toMatchObject({ outcome: 'unparked' });

    // ── wallets, donations, the pool refill ───────────────────────────────────────
    await db.update(organizations).set({ stripeCustomerId: `cus_${createId()}` }).where(eq(organizations.id, orgId));
    await db.insert(wallets).values({ ownerType: 'org', orgId, monthlyRemainingCents: 500_000 });
    await db.insert(wallets).values({ userId: dana.id, monthlyRemainingCents: 5_000, monthlyPeriodStart: new Date(), monthlyPeriodEnd: new Date(Date.now() + 20 * 86_400_000) });
    expect(await createDriveWallet(jono.id, productId, { allocationCents: 10_000 }, 'session')).toMatchObject({ ok: true });
    expect(await updateDriveWallet(jono.id, productId, { donationsEnabled: true }, 'session')).toMatchObject({ ok: true });
    expect(await topUpDriveWallet(jono.id, productId, { amountCents: 500, idempotencyKey: createId() }, 'session')).toMatchObject({ ok: true, duplicate: false });
    expect(await donateToDrive(dana.id, productId, { amountCents: 100, idempotencyKey: createId() }, 'session')).toMatchObject({ ok: true, duplicate: false });
    const [orgRow] = await db.select().from(organizations).where(eq(organizations.id, orgId));
    const startS = Math.floor(Date.now() / 1000);
    expect(await applyOrgPoolRefill({
      id: `in_${createId()}`,
      customer: orgRow.stripeCustomerId,
      billing_reason: 'subscription_cycle',
      amount_paid: 5000,
      subtotal: 5000,
      parent: { subscription_details: { subscription: `sub_${createId()}` } },
      lines: { data: [{ amount: 5000, period: { start: startS, end: startS + 30 * 86_400 } }] },
    }, { active: true })).toMatchObject({ kind: 'granted' });

    // ── verified domains and auto-join (one refused while seats are full, one joined with auto-add) ──
    const claim = await addOrgDomain({ orgId, domain, actorId: jono.id });
    if (!claim.ok) throw new Error('domain');
    expect((await sendDomainProofEmail({ orgId, domainId: claim.domain.id, mailbox: 'admin', actorId: jono.id, now: new Date(), deliver: async () => {} })).ok).toBe(true);
    const txt = async (name: string) => (name === dnsRecordName(domain) ? [[dnsRecordValue(claim.domain.dnsToken)]] : []);
    expect((await verifyOrgDomainByDns({ orgId, domainId: claim.domain.id, actorId: jono.id, now: new Date(), resolveTxt: txt })).ok).toBe(true);
    const aisha = await person('Aisha Bello', `aisha@${domain}`);
    expect(await autoJoinVerifiedDomainOrg({ userId: aisha.id, now: new Date() })).toMatchObject({ kind: 'refused', reason: 'seats_full' });
    await setSeatAutoAdd(orgId, true, jono.id);
    const nina = await person('Nina Brandt', `nina@${domain}`);
    expect(await autoJoinVerifiedDomainOrg({ userId: nina.id, now: new Date(), seatBilling: stripe })).toMatchObject({ kind: 'joined' });
    expect(await removeOrgDomain({ orgId, domainId: claim.domain.id, actorId: jono.id })).toBe(true);

    // ── [D-OW-36] Dana's automations in Product outlive her: flagged when she is removed, then one is
    //    reassigned to Marcus and the other deleted ─────────────────────────────────────────────
    const [danaDigest] = await db.insert(workflows).values({ driveId: productId, createdBy: dana.id, name: 'Digest', prompt: 'x', cronExpression: '0 * * * *' }).returning();
    const [danaNudge] = await db.insert(workflows).values({ driveId: productId, createdBy: dana.id, name: 'Nudge', prompt: 'x', cronExpression: '0 9 * * *' }).returning();

    // ── leaving: removal, a chosen leave, ownership, and the org's deletion ──────────
    expect((await removeMember({ orgId, actorId: jono.id, targetId: dana.id })).ok).toBe(true);
    expect(await reassignOwnerLeftAutomation({ orgId, actorId: jono.id, kind: 'workflow', id: danaDigest.id, newOwnerId: marcus.id })).toEqual({ ok: true });
    expect(await deleteOwnerLeftAutomation({ orgId, actorId: jono.id, kind: 'workflow', id: danaNudge.id })).toEqual({ ok: true });
    // [D-OW-27] Dana deletes her account: her address stays suppressed until an Admin clears it.
    await accountRepository.deleteUser(dana.id);
    expect(await clearDepartureSuppression({ orgId, email: dana.email, actorId: jono.id })).toBe(true);
    expect((await leaveOrganization(tomas.id, orgId)).ok).toBe(true);
    expect((await transferOwnership({ orgId, actorId: jono.id, targetId: priya.id })).ok).toBe(true);

    // Every event so far is in the org's log.
    await vi.waitFor(async () => expect(await typesFor(orgId)).toContain('authz.access.granted'), { timeout: 10_000, interval: 100 });
    const beforeDelete = await typesFor(orgId);

    const orgDriveIds = (await db.select({ id: drives.id }).from(drives).where(eq(drives.orgId, orgId))).map((d) => d.id);
    await db.delete(wallets).where(inArray(wallets.parentWalletId, db.select({ id: wallets.id }).from(wallets).where(eq(wallets.orgId, orgId))));
    const deleted = await deleteOrganization(
      { actorId: priya.id, orgId, choices: orgDriveIds.map((driveId) => ({ driveId, action: 'trash' as const })), now: new Date() },
      { endSubscription: async () => {}, ports: { broadcast: async () => {}, kick: async () => {} } },
    );
    expect(deleted.ok).toBe(true);
    created.drives.push(...orgDriveIds);
    const all = await typesFor(orgId);

    const libEmitted = ORG_AUDIT_EVENT_TYPES.filter((type) => !(type in WEB_EMITTED));
    const missing = libEmitted.filter((type) => !all.has(type));
    expect(missing).toEqual([]);
    for (const type of beforeDelete) expect(all.has(type)).toBe(true);

    // Bounded on both sides: rows another suite dated in the future (fake clocks) are not this run's.
    const chain = await verifySecurityAuditChain({ fromTimestamp: startedAt, toTimestamp: new Date(), stopOnFirstBreak: true });
    expect(chain.breakPoint).toBeNull();
    expect(chain.isValid).toBe(true);
  }, 120_000);

  it('AUD-1 (partial) every catalog type has an emitter: lib (proven above) or a named apps/web file that writes it', () => {
    for (const [type, files] of Object.entries(WEB_EMITTED)) {
      for (const file of files ?? []) {
        expect(fs.readFileSync(path.join(REPO, file), 'utf8'), `${file} writes ${type}`).toContain(`'${type}'`);
      }
    }
    for (const type of Object.keys(WEB_EMITTED)) expect(ORG_AUDIT_EVENT_TYPES).toContain(type);
  });
});
