/**
 * The agent CLAIM ceremony end to end, against a REAL Postgres (Agent Signup
 * Phase 4; ADR 0008 Decisions 3, 7, 8, §5 assertion 22; auth.md "Fund").
 *
 *   register → exchange (pre-claim tokens) → POST /api/agent/claim → poll
 *   (pending, then slow_down) → verify → approve → owner set + claim token
 *   nulled + emailVerified stamped, in one transaction → poll (claimed:true,
 *   owner, tokens for the AGENT) → second poll refused → the pre-claim
 *   ps_at_/ps_rt_ still work (Decision 7).
 *
 * Plus what only real row locks can show — the Phase 0 decisions under FOR
 * UPDATE: two humans approving one code at once settle exactly one owner; an
 * agent can never be the claimer (the human-only rule, before anything else);
 * an unlink between approval and poll makes the stale grant access_denied; a
 * superseded code can no longer be approved.
 *
 * The init and poll go through the production route handlers; the human's
 * verify/decision go through the repository the session-gated routes call
 * (their session/CSRF/rate-limit edges have route unit tests). Only the audit
 * writer is stubbed.
 *
 * Requires DATABASE_URL → a migrated Postgres. FAILS LOUDLY when none is
 * reachable (requireDb); local runs without one opt out with ALLOW_SKIP_DB_TESTS=1.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.AGENT_SIGNUP_POW_BITS = '8';
  process.env.WEB_APP_URL = 'https://pagespace.test';
  process.env.TRUSTED_PROXY_HOPS = '1';
});

vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn(), audit: vi.fn() }));

import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { agentClaims, agentIdentities } from '@pagespace/db/schema/agent-identities';
import { requireDb } from '@pagespace/db/test/require-db';
import { factories } from '@pagespace/db/test/factories';
import { solvePow } from '@pagespace/lib/auth/agent/pow';
import { normalizeUserCode } from '@pagespace/lib/auth/oauth/user-code';
import { hashToken } from '@pagespace/lib/auth/token-utils';

let dbAvailable = false;
const createdUserIds: string[] = [];
// A fresh, VALID IP per caller: the rate-limit buckets are real rows that outlive
// the test, and an unparseable address collapses into the one `unknown` bucket.
const randomIp = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const IP = randomIp();
const JWT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const CLAIM_GRANT = 'urn:pagespace:agent-auth:grant-type:claim';

type Handler = (req: Request) => Promise<Response>;
let challengeGET: () => Promise<Response>;
let identityPOST: Handler;
let claimPOST: Handler;
let tokenPOST: Handler;
let meGET: Handler;
let repo: typeof import('@/lib/repositories/agent-claim-repository');

const json = (url: string, body: unknown, ip = IP) =>
  new Request(`https://pagespace.test${url}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(body) });
const form = (fields: Record<string, string>) =>
  new Request('https://pagespace.test/api/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': IP }, body: new URLSearchParams(fields).toString() });
const bearer = (url: string, token: string) =>
  new Request(`https://pagespace.test${url}`, { headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': IP } });

interface RegisteredAgent { agentId: string; secret: string; claimToken: string; accessToken: string; refreshToken: string }

async function registerAgent(name: string): Promise<RegisteredAgent> {
  const challengeRes = await challengeGET();
  const { challenge, difficulty_bits } = await challengeRes.json() as { challenge: string; difficulty_bits: number };
  const reg = await identityPOST(json('/api/agent/identity', {
    type: 'anonymous', name, source: 'claim-flow-test', tos_accepted: true,
    pow: { challenge, nonce: solvePow(challenge, difficulty_bits) },
  }, randomIp()));
  expect(reg.status).toBe(200);
  const identity = await reg.json() as { identity_assertion: string; agent_id: string; claim_token: string };
  createdUserIds.push(identity.agent_id);
  const exchanged = await tokenPOST(form({ grant_type: JWT, assertion: identity.identity_assertion, client_id: 'pagespace-agent' }));
  expect(exchanged.status).toBe(200);
  const pair = await exchanged.json() as { access_token: string; refresh_token: string };
  return { agentId: identity.agent_id, secret: identity.identity_assertion, claimToken: identity.claim_token, accessToken: pair.access_token, refreshToken: pair.refresh_token };
}

async function startClaim(claimToken: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await claimPOST(json('/api/agent/claim', { claim_token: claimToken }, randomIp()));
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

async function poll(claimToken: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await tokenPOST(form({ grant_type: CLAIM_GRANT, claim_token: claimToken, client_id: 'pagespace-agent' }));
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

async function human(name: string): Promise<string> {
  const user = await factories.createUser({ name, accountType: 'human' });
  createdUserIds.push(user.id);
  return user.id;
}

async function identityOf(agentId: string) {
  const [row] = await db
    .select({ ownerUserId: agentIdentities.ownerUserId, claimedAt: agentIdentities.claimedAt, claimTokenHash: agentIdentities.claimTokenHash, emailVerified: users.emailVerified })
    .from(agentIdentities)
    .innerJoin(users, eq(users.id, agentIdentities.userId))
    .where(eq(agentIdentities.userId, agentId));
  return row;
}

beforeAll(async () => {
  try {
    await db.select({ id: users.id }).from(users).limit(1);
    dbAvailable = true;
  } catch (error) {
    requireDb('agent-claim-flow.integration.test.ts', error);
    dbAvailable = false;
  }
  const challengeRoute = await import('../challenge/route');
  challengeGET = () => challengeRoute.GET(new Request('https://pagespace.test/api/agent/challenge', { headers: { 'x-forwarded-for': IP } }));
  identityPOST = (await import('../identity/route')).POST;
  claimPOST = (await import('../claim/route')).POST;
  tokenPOST = (await import('../../oauth/token/route')).POST as unknown as Handler;
  meGET = (await import('../../auth/me/route')).GET;
  repo = await import('@/lib/repositories/agent-claim-repository');
});

afterAll(async () => {
  if (!dbAvailable || createdUserIds.length === 0) return;
  await db.delete(drives).where(inArray(drives.ownerId, createdUserIds));
  await db.delete(users).where(inArray(users.id, createdUserIds));
});

describe('agent claim ceremony — real Postgres', () => {
  it('init → pending → slow_down → verify → approve → owner set → claimed poll → second poll refused; pre-claim tokens survive', async () => {
    if (!dbAvailable) return;
    const agent = await registerAgent('Claimable Agent');
    const ownerId = await human('Ada Owner');

    // Init.
    const started = await startClaim(agent.claimToken);
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ verification_uri: 'https://pagespace.test/claim', expires_in: 900, interval: 5 });
    const userCode = String(started.body.user_code);
    expect(userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(started.body.verification_uri_complete).toBe(`https://pagespace.test/claim?user_code=${encodeURIComponent(userCode)}`);
    // Stored hash-only.
    const [claimRow] = await db.select({ userCodeHash: agentClaims.userCodeHash, claimTokenHash: agentClaims.claimTokenHash }).from(agentClaims).where(eq(agentClaims.agentUserId, agent.agentId));
    expect(claimRow).toEqual({ userCodeHash: hashToken(normalizeUserCode(userCode)), claimTokenHash: hashToken(agent.claimToken) });

    // Poll before the human acts: pending, then slow_down when polled again inside the interval.
    expect(await poll(agent.claimToken)).toEqual({ status: 400, body: { error: 'authorization_pending' } });
    expect(await poll(agent.claimToken)).toEqual({ status: 400, body: { error: 'slow_down' } });

    // The human verifies: the screen names the agent.
    const verified = await repo.verifyAgentClaimUserCode({ userCode, claimerUserId: ownerId, now: new Date() });
    expect(verified).toMatchObject({ outcome: 'ok', agent: { agentUserId: agent.agentId, name: 'Claimable Agent', source: 'claim-flow-test' } });

    // Approve.
    expect(await repo.recordAgentClaimDecision({ userCode, action: 'approve', claimerUserId: ownerId, now: new Date() })).toEqual({ outcome: 'approved', agentUserId: agent.agentId });
    const afterApproval = await identityOf(agent.agentId);
    expect(afterApproval.ownerUserId).toBe(ownerId);
    expect(afterApproval.claimedAt).toBeInstanceOf(Date);
    expect(afterApproval.claimTokenHash).toBeNull();
    // D-31 option A: the claimed agent may now DM, invite and upload.
    expect(afterApproval.emailVerified).toBeInstanceOf(Date);

    // The claim token can start no further claim.
    expect(await startClaim(agent.claimToken)).toEqual({ status: 400, body: { error: 'invalid_request' } });

    // Poll: claimed, the owner, and a fresh pair minted for the AGENT (a settled
    // record reports its outcome regardless of the throttle).
    const claimed = await poll(agent.claimToken);
    expect(claimed.status).toBe(200);
    expect(claimed.body).toMatchObject({ claimed: true, owner: { id: ownerId, name: 'Ada Owner' }, token_type: 'Bearer', scope: 'account offline_access' });
    const claimedAccess = String(claimed.body.access_token);
    expect(claimedAccess.startsWith('ps_at_')).toBe(true);
    const [redeemed] = await db.select({ redeemedAt: agentClaims.redeemedAt }).from(agentClaims).where(eq(agentClaims.agentUserId, agent.agentId));
    expect(redeemed.redeemedAt).toBeInstanceOf(Date);

    // A second poll is dead.
    expect(await poll(agent.claimToken)).toEqual({ status: 400, body: { error: 'invalid_grant' } });

    // The new token is the agent, now owned.
    const meNew = await meGET(bearer('/api/auth/me', claimedAccess));
    expect(meNew.status).toBe(200);
    expect(await meNew.json()).toMatchObject({ id: agent.agentId, accountType: 'agent', agent: { ownerUserId: ownerId } });

    // Decision 7: the pre-claim access AND refresh tokens still work.
    expect((await meGET(bearer('/api/auth/me', agent.accessToken))).status).toBe(200);
    const refreshed = await tokenPOST(form({ grant_type: 'refresh_token', refresh_token: agent.refreshToken, client_id: 'pagespace-agent' }));
    expect(refreshed.status).toBe(200);
  });

  it('given two humans approving ONE code at the same moment, should settle exactly one owner (FOR UPDATE)', async () => {
    if (!dbAvailable) return;
    const agent = await registerAgent('Contested Agent');
    const [alice, bob] = [await human('Alice'), await human('Bob')];
    const userCode = String((await startClaim(agent.claimToken)).body.user_code);

    const now = new Date();
    const results = await Promise.all([
      repo.recordAgentClaimDecision({ userCode, action: 'approve', claimerUserId: alice, now }),
      repo.recordAgentClaimDecision({ userCode, action: 'approve', claimerUserId: bob, now }),
    ]);

    const approved = results.filter((r) => r.outcome === 'approved');
    const refused = results.filter((r) => r.outcome === 'refused');
    expect(approved).toHaveLength(1);
    expect(refused).toHaveLength(1);
    const refusal = refused[0];
    expect(refusal.outcome === 'refused' ? refusal.decision.status : null).toBe('already_claimed');
    const owner = (await identityOf(agent.agentId)).ownerUserId;
    expect([alice, bob]).toContain(owner);
    // Only one claim row was approved, for the owner that won.
    const rows = await db.select({ ownerUserId: agentClaims.ownerUserId, approvedAt: agentClaims.approvedAt }).from(agentClaims).where(eq(agentClaims.agentUserId, agent.agentId));
    expect(rows.filter((r) => r.approvedAt !== null).map((r) => r.ownerUserId)).toEqual([owner]);
  });

  it('given an AGENT as the claimer, should refuse not_human and leave the agent unclaimed (human-only rule)', async () => {
    if (!dbAvailable) return;
    const target = await registerAgent('Target Agent');
    const claimer = await registerAgent('Claimer Agent');
    const userCode = String((await startClaim(target.claimToken)).body.user_code);

    expect(await repo.verifyAgentClaimUserCode({ userCode, claimerUserId: claimer.agentId, now: new Date() })).toEqual({ outcome: 'not_human' });
    const decided = await repo.recordAgentClaimDecision({ userCode, action: 'approve', claimerUserId: claimer.agentId, now: new Date() });
    expect(decided).toMatchObject({ outcome: 'refused', decision: { status: 'not_human' } });
    expect((await identityOf(target.agentId)).ownerUserId).toBeNull();
    expect((await identityOf(target.agentId)).emailVerified).toBeNull();
    // The claim is still pending for a human to approve.
    expect(await poll(target.claimToken)).toEqual({ status: 400, body: { error: 'authorization_pending' } });
  });

  it('given a denial, should answer access_denied and let the agent start a fresh claim', async () => {
    if (!dbAvailable) return;
    const agent = await registerAgent('Denied Agent');
    const someone = await human('Dee');
    const userCode = String((await startClaim(agent.claimToken)).body.user_code);

    expect(await repo.recordAgentClaimDecision({ userCode, action: 'deny', claimerUserId: someone, now: new Date() })).toEqual({ outcome: 'denied', agentUserId: agent.agentId });
    expect(await poll(agent.claimToken)).toEqual({ status: 400, body: { error: 'access_denied' } });
    expect((await identityOf(agent.agentId)).claimTokenHash).toBe(hashToken(agent.claimToken));

    const again = await startClaim(agent.claimToken);
    expect(again.status).toBe(200);
    expect(await poll(agent.claimToken)).toEqual({ status: 400, body: { error: 'authorization_pending' } });
  });

  it('given a second start, should supersede the first code so it can never be approved', async () => {
    if (!dbAvailable) return;
    const agent = await registerAgent('Restarted Agent');
    const someone = await human('Sam');
    const firstCode = String((await startClaim(agent.claimToken)).body.user_code);
    const secondCode = String((await startClaim(agent.claimToken)).body.user_code);
    expect(secondCode).not.toBe(firstCode);

    expect(await repo.verifyAgentClaimUserCode({ userCode: firstCode, claimerUserId: someone, now: new Date() })).toEqual({ outcome: 'not_found' });
    expect(await repo.recordAgentClaimDecision({ userCode: firstCode, action: 'approve', claimerUserId: someone, now: new Date() })).toMatchObject({ outcome: 'refused', decision: { status: 'already_settled' } });
    expect((await repo.verifyAgentClaimUserCode({ userCode: secondCode, claimerUserId: someone, now: new Date() })).outcome).toBe('ok');
  });

  it('given an unlink between approval and poll, should answer access_denied — never a stale grant', async () => {
    if (!dbAvailable) return;
    const agent = await registerAgent('Unlinked Agent');
    const ownerId = await human('Una');
    const userCode = String((await startClaim(agent.claimToken)).body.user_code);
    expect((await repo.recordAgentClaimDecision({ userCode, action: 'approve', claimerUserId: ownerId, now: new Date() })).outcome).toBe('approved');

    await db.update(agentIdentities).set({ ownerUserId: null, claimedAt: null }).where(eq(agentIdentities.userId, agent.agentId));

    expect(await poll(agent.claimToken)).toEqual({ status: 400, body: { error: 'access_denied' } });
  });

  it('given an unknown claim token, should answer the one 400 at init and invalid_grant on poll', async () => {
    if (!dbAvailable) return;
    expect(await startClaim('ps_claim_doesnotexist000000000000000')).toEqual({ status: 400, body: { error: 'invalid_request' } });
    expect(await poll('ps_claim_doesnotexist000000000000000')).toEqual({ status: 400, body: { error: 'invalid_grant' } });
  });
});
