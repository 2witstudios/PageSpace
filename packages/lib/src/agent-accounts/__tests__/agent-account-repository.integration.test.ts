/**
 * L2·G2 — the account reference repository against the REAL `:5433` Postgres
 * (Control Board §7.3). Pins the races it owns as single statements: the first
 * committed put (credentialVersion 0 → n once), approval consumption (one
 * grant stamps it, never two, never after expiry), revocation (policyVersion
 * bump, first revocation time kept) and the bounded lists. FAILS LOUDLY when
 * no DB is reachable (`requireDb`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@pagespace/db/db';
import { eq, sql } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives, pages } from '@pagespace/db/schema/core';
import { agentAccounts } from '@pagespace/db/schema/agent-accounts';
import type { TenantId } from '@pagespace/db/schema/agent-accounts';
import { requireDb } from '@pagespace/db/test/require-db';
import type { CanonicalOrigin } from '../canonical-request';
import type { GrantId, RequestDigest } from '../grant';
import { createAgentAccountRepository } from '../agent-account-repository';

const RUN = `g2repo${Date.now()}`;
const USER = `${RUN}_user`;
const DRIVE = `${RUN}_drive`;
const PAGE = `${RUN}_page`;
const repo = createAgentAccountRepository({ db });
const draft = { kind: 'api_key' as const, name: 'Weather', allowedOrigins: ['https://api.weather.example:443' as CanonicalOrigin], acknowledgment: 'dedicated_agent_account' as const, placement: { in: 'header' as const, name: 'authorization' }, approvalPolicy: null };

beforeAll(async () => {
  try {
    await db.execute(sql`SELECT 1`);
  } catch (error) {
    requireDb('agent-account-repository.integration.test.ts', error);
  }
  await db.insert(users).values({ id: USER, name: 'repo test', email: `${RUN}@example.test` });
  await db.insert(drives).values({ id: DRIVE, name: 'd', slug: DRIVE, ownerId: USER });
  await db.insert(pages).values({ id: PAGE, title: 'agent', type: 'AI_CHAT', driveId: DRIVE, position: 0 });
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, USER));
});

describe('createAgentAccountRepository — against the real database', () => {
  it('given an agent-page owner, should insert an unprovisioned row with the derived tenant and list it for that page only', async () => {
    const row = await repo.insert({ draft, owner: { kind: 'agent_page', agentPageId: PAGE, driveId: DRIVE }, tenantId: `drive:${DRIVE}` as TenantId, approvalPolicy: null });
    const forPage = await repo.listForAgentPage(PAGE);
    const forUser = await repo.listForUser(USER);
    const actual = { tenant: row.tenantId, credentialVersion: row.credentialVersion, acknowledgment: row.acknowledgment, listedForPage: forPage.some((r) => r.id === row.id), listedForUser: forUser.some((r) => r.id === row.id) };
    const expected = { tenant: `drive:${DRIVE}`, credentialVersion: 0, acknowledgment: 'dedicated_agent_account', listedForPage: true, listedForUser: false };
    expect(actual).toEqual(expected);
  });

  it('given the first committed put, should move credentialVersion 0 → 1 exactly once', async () => {
    const row = await repo.insert({ draft, owner: { kind: 'user', userId: USER }, tenantId: `user:${USER}` as TenantId, approvalPolicy: null });
    const actual = [await repo.setCredentialVersion({ id: row.id, version: 1 }), await repo.setCredentialVersion({ id: row.id, version: 2 }), (await repo.find(row.id))?.credentialVersion];
    const expected = [true, false, 1];
    expect(actual).toEqual(expected);
  });

  it('given an allow-once approval, should hand it out while open and let exactly one of two concurrent grants consume it', async () => {
    const row = await repo.insert({ draft, owner: { kind: 'user', userId: USER }, tenantId: `user:${USER}` as TenantId, approvalPolicy: null });
    const now = Date.now();
    const approvalId = await repo.insertApproval({ accountId: row.id, requestDigest: 'digest_1' as RequestDigest, approvedByUserId: USER, approvedViaSessionId: 'sess_1', stepUpChallengeId: null, expiresAt: now + 60_000 });
    const open = await repo.openApprovals({ accountId: row.id, now });
    const results = await Promise.all([repo.consumeApproval({ approvalId, grantId: 'grant_a' as GrantId, now }), repo.consumeApproval({ approvalId, grantId: 'grant_b' as GrantId, now })]);
    const fact = await repo.findApproval(approvalId);
    const actual = { open: open.map((a) => a.approvalId), winners: results.filter(Boolean).length, stampedBy: fact !== null && ['grant_a', 'grant_b'].includes(fact.consumedByGrantId ?? ''), stillOpen: (await repo.openApprovals({ accountId: row.id, now })).length };
    const expected = { open: [approvalId], winners: 1, stampedBy: true, stillOpen: 0 };
    expect(actual).toEqual(expected);
  });

  it('given an expired approval, should neither list nor let it be consumed', async () => {
    const row = await repo.insert({ draft, owner: { kind: 'user', userId: USER }, tenantId: `user:${USER}` as TenantId, approvalPolicy: null });
    const now = Date.now();
    const approvalId = await repo.insertApproval({ accountId: row.id, requestDigest: 'digest_2' as RequestDigest, approvedByUserId: USER, approvedViaSessionId: 'sess_1', stepUpChallengeId: null, expiresAt: now - 1 });
    const actual = { open: (await repo.openApprovals({ accountId: row.id, now })).length, consumed: await repo.consumeApproval({ approvalId, grantId: 'grant_c' as GrantId, now }) };
    const expected = { open: 0, consumed: false };
    expect(actual).toEqual(expected);
  });

  it('given revocation twice, should mark it revoked, bump policyVersion each time and keep the first revocation time', async () => {
    const row = await repo.insert({ draft, owner: { kind: 'user', userId: USER }, tenantId: `user:${USER}` as TenantId, approvalPolicy: null });
    const first = await repo.markRevoked({ id: row.id, at: 1_800_000_000_000 });
    const second = await repo.markRevoked({ id: row.id, at: 1_800_000_999_000 });
    const actual = { status: second?.status, policyVersions: [row.policyVersion, first?.policyVersion, second?.policyVersion], revokedAt: second?.revokedAt?.getTime(), upstream: second?.upstreamRevocation };
    const expected = { status: 'revoked', policyVersions: [1, 2, 3], revokedAt: 1_800_000_000_000, upstream: 'not_attempted' };
    expect(actual).toEqual(expected);
  });

  it('given the refresh worker mirroring a rotation, should advance credentialVersion only from the version it read — a stale mirror never moves it backwards (L3·G3)', async () => {
    const row = await repo.insert({ draft, owner: { kind: 'user', userId: USER }, tenantId: `user:${USER}` as TenantId, approvalPolicy: null });
    await repo.setCredentialVersion({ id: row.id, version: 1 });
    const actual = [
      await repo.advanceCredentialVersion({ id: row.id, from: 1, to: 2 }),
      await repo.advanceCredentialVersion({ id: row.id, from: 1, to: 2 }),
      await repo.advanceCredentialVersion({ id: row.id, from: 3, to: 1 }),
      (await repo.find(row.id))?.credentialVersion,
    ];
    const expected = [true, false, false, 2];
    expect(actual).toEqual(expected);
  });

  it('given a dead upstream grant, should move an active account to needs_reauth and never touch a revoked one (L3·G3)', async () => {
    const active = await repo.insert({ draft, owner: { kind: 'user', userId: USER }, tenantId: `user:${USER}` as TenantId, approvalPolicy: null });
    const revoked = await repo.insert({ draft, owner: { kind: 'user', userId: USER }, tenantId: `user:${USER}` as TenantId, approvalPolicy: null });
    await repo.markRevoked({ id: revoked.id, at: 1_800_000_000_000 });
    const actual = {
      marked: [await repo.markNeedsReauth({ id: active.id, at: 1_800_000_000_000 }), await repo.markNeedsReauth({ id: revoked.id, at: 1_800_000_000_000 })],
      statuses: [(await repo.find(active.id))?.status, (await repo.find(revoked.id))?.status],
    };
    const expected = { marked: [true, false], statuses: ['needs_reauth', 'revoked'] };
    expect(actual).toEqual(expected);
  });

  it('given the owning user deleted, should cascade the accounts away', async () => {
    const other = `${RUN}_gone`;
    await db.insert(users).values({ id: other, name: 'gone', email: `${other}@example.test` });
    const row = await repo.insert({ draft, owner: { kind: 'user', userId: other }, tenantId: `user:${other}` as TenantId, approvalPolicy: null });
    await db.delete(users).where(eq(users.id, other));
    const actual = await db.select().from(agentAccounts).where(eq(agentAccounts.id, row.id));
    const expected: unknown[] = [];
    expect(actual).toEqual(expected);
  });
});
