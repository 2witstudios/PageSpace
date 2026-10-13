/**
 * AUD-1 for guest approvals, against a real Postgres: the `org.guest.approved` event is staged INSIDE the admission's
 * own transaction, already releasable, so it exists exactly when the guest was admitted. A process that dies right
 * after the admission commits (simulated: the post-commit publish never reaches the chain) loses nothing; the
 * drainer delivers it. An admission that does not commit leaves no event.
 *
 * Run via:
 *   bun run --filter '@pagespace/lib' test:integration -- src/permissions/__tests__/guest-approval-audit.integration.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { factories } from '@pagespace/db/test/factories';
import { db, pool } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { orgAuditOutbox, organizations, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';
import { orgGuestHolds } from '@pagespace/db/schema/org-guest-holds';
import type { SessionClaims } from '../../auth/session-service';
import type { AuditEvent } from '../../audit/security-audit';
import { EnforcedAuthContext } from '../enforced-context';

const chain = vi.hoisted(() => ({ appended: [] as AuditEvent[], refuse: false }));
vi.mock('../../audit/security-audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../audit/security-audit')>();
  return {
    ...actual,
    securityAudit: {
      ...actual.securityAudit,
      logEvent: vi.fn(async (entry: AuditEvent) => {
        if (chain.refuse) throw new Error('audit chain unavailable');
        chain.appended.push(entry);
      }),
    },
  };
});
vi.mock('../../organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));
vi.mock('../revocation-kick', () => ({ kickForDriveMembershipRevocation: vi.fn(async () => {}), kickForPagePermissionRevocation: vi.fn(async () => {}) }));

import { createDriveShareLink, completeApprovedLinkAdmission, redeemDriveShareLink } from '../share-link-service';
import { claimGuestApprovalDecision, guestDecisionAuditEvent } from '../guest-holds';
import { drainOrgAuditOutbox } from '../../audit/org-audit';
import { ORG_AUDIT_PENDING_HOLD_MS } from '../../audit/org-audit-outbox-core';
import { updateOrgPolicies } from '../../organizations/policies';
import { getUserDriveAccess } from '../permissions';
import { credentialActor } from '../access-actor';

const created = { users: [] as string[], drives: [] as string[], orgs: [] as string[] };
const ctxFor = (userId: string): EnforcedAuthContext => {
  const claims: SessionClaims = {
    sessionId: 'sess', userId, userRole: 'user', tokenVersion: 1, adminRoleVersion: 0, type: 'user', scopes: ['*'],
    expiresAt: new Date(Date.now() + 3_600_000), driveId: undefined,
  };
  return EnforcedAuthContext.fromSession(claims);
};
const person = async () => {
  const u = await factories.createUser();
  created.users.push(u.id);
  return u.id;
};

let w: { orgId: string; owner: string; drive: string };

beforeEach(async () => {
  chain.appended.length = 0;
  chain.refuse = false;
  const owner = await person();
  const orgId = createId();
  created.orgs.push(orgId);
  await db.insert(organizations).values({ id: orgId, name: 'Northwind', slug: `nw-${createId().slice(0, 10)}`, ownerId: owner, policies: { guests: 'approve' } });
  await factories.createOrgSubscription(orgId);
  await db.insert(orgMembers).values({ orgId, userId: owner, role: 'OWNER' });
  const d = await factories.createDrive(owner);
  created.drives.push(d.id);
  await db.update(drives).set({ orgId, orgVisibility: 'OPEN' }).where(eq(drives.id, d.id));
  w = { orgId, owner, drive: d.id };
});

afterEach(async () => {
  await db.delete(orgAuditOutbox).where(inArray(orgAuditOutbox.orgId, created.orgs.length ? created.orgs : ['-']));
  if (created.drives.length) await db.delete(drives).where(inArray(drives.id, created.drives));
  if (created.orgs.length) {
    await db.delete(orgMembers).where(inArray(orgMembers.orgId, created.orgs));
    await db.delete(orgSubscriptions).where(inArray(orgSubscriptions.orgId, created.orgs));
    await db.delete(organizations).where(inArray(organizations.id, created.orgs));
  }
  if (created.users.length) await db.delete(users).where(inArray(users.id, created.users));
  created.users = [];
  created.drives = [];
  created.orgs = [];
});
afterAll(() => pool.end());

/** An outsider queued by a drive link under guests: approve, and the Owner's approval claimed. */
async function approvedLinkRequest() {
  const link = await createDriveShareLink(ctxFor(w.owner), w.drive, {});
  if (!link.ok) throw new Error('setup: link');
  const outsider = await person();
  expect(await redeemDriveShareLink(ctxFor(outsider), link.data.rawToken)).toMatchObject({ ok: false, error: 'PENDING_APPROVAL' });
  const [hold] = await db.select({ id: orgGuestHolds.id }).from(orgGuestHolds).where(eq(orgGuestHolds.driveId, w.drive));
  const decided = await claimGuestApprovalDecision({ orgId: w.orgId, holdId: hold.id, decision: 'approve', actorId: w.owner });
  if (!decided.ok) throw new Error('setup: claim');
  return { outsider, claim: decided.claim };
}

const approvals = () => chain.appended.filter((e) => e.eventType === 'org.guest.approved' && e.details?.orgId === w.orgId);

describe('the approval event is committed with the admission', () => {
  it('AUD-1 (partial) a process that dies right after the admission commits loses nothing: the event was staged in the admission and the drainer delivers it', async () => {
    const { outsider, claim } = await approvedLinkRequest();
    // The post-commit publish never reaches the chain: what a crash after the commit leaves behind.
    chain.refuse = true;
    expect(await completeApprovedLinkAdmission(claim, guestDecisionAuditEvent(claim, 'org.guest.approved', w.owner))).toMatchObject({ ok: true });
    expect(await getUserDriveAccess(credentialActor(outsider, null), w.drive)).toBe(true);
    expect(approvals()).toEqual([]);
    const [row] = await db.select().from(orgAuditOutbox).where(eq(orgAuditOutbox.eventType, 'org.guest.approved')).then((rows) => rows.filter((r) => r.orgId === w.orgId));
    // Committed with the admission and queued (the refused publish counted one attempt), never a hold.
    expect(row).toMatchObject({ attempts: 1 });

    chain.refuse = false;
    await drainOrgAuditOutbox({ now: new Date(Date.now() + ORG_AUDIT_PENDING_HOLD_MS + 2 * 60 * 60_000) });
    expect(approvals()).toEqual([expect.objectContaining({ userId: w.owner, details: expect.objectContaining({ targetUserId: outsider, origin: 'drive_link' }) })]);
  });

  it('AUD-1 (partial) an admission that does not commit (guests turned off meanwhile) leaves no approval event at all', async () => {
    const { outsider, claim } = await approvedLinkRequest();
    await updateOrgPolicies({ actorAuthentication: null, orgId: w.orgId, actorId: w.owner, patch: { guests: 'off' } });
    expect(await completeApprovedLinkAdmission(claim, guestDecisionAuditEvent(claim, 'org.guest.approved', w.owner))).toMatchObject({ ok: false });
    expect(await getUserDriveAccess(credentialActor(outsider, null), w.drive)).toBe(false);
    await drainOrgAuditOutbox({ now: new Date(Date.now() + ORG_AUDIT_PENDING_HOLD_MS + 2 * 60 * 60_000) });
    expect(approvals()).toEqual([]);
    expect((await db.select().from(orgAuditOutbox).where(eq(orgAuditOutbox.eventType, 'org.guest.approved'))).filter((r) => r.orgId === w.orgId)).toEqual([]);
  });
});
