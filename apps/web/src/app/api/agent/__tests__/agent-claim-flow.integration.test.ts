/**
 * The agent CLAIM ceremony end to end, against a REAL Postgres (Agent Signup
 * Phase 4; ADR 0008 Decisions 3, 7, 8, §5 assertion 22 and the security review
 * addendum; auth.md "Fund").
 *
 *   register → exchange (the agent's tokens) → POST /api/agent/claim with the
 *   agent's OWN Bearer → poll with the same Bearer (pending, then slow_down)
 *   → verify → approve → owner set + emailVerified stamped, in one transaction
 *   → poll ({claimed:true, owner} — no token of any kind) → second poll
 *   refused → the agent's own ps_at_/ps_rt_ still work (Decision 7).
 *
 * Plus the security review's exploit chain, as a regression: whoever is not
 * the agent — a claim-token holder, a throwaway approver, the former owner
 * after an unlink — can start nothing, poll nothing, approve nothing and is
 * handed no credential. And what only real row locks can show: two humans
 * approving one code at once settle exactly one owner; an agent can never be
 * the claimer; an unlink between approval and poll makes the stale grant
 * access_denied; a superseded code can no longer be approved.
 *
 * The start and poll go through the production route handlers; the human's
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
import { oauthAccessTokens } from '@pagespace/db/schema/oauth';
import { drives } from '@pagespace/db/schema/core';
import { agentClaims, agentIdentities } from '@pagespace/db/schema/agent-identities';
import { requireDb } from '@pagespace/db/test/require-db';
import { factories } from '@pagespace/db/test/factories';
import { solvePow } from '@pagespace/lib/auth/agent/pow';
import { normalizeUserCode } from '@pagespace/lib/auth/oauth/user-code';
import { hashToken } from '@pagespace/lib/auth/token-utils';
import { issueInitialTokenPair } from '@pagespace/lib/auth/oauth/issue-tokens';
import { getRegisteredClient } from '@pagespace/lib/auth/oauth/clients';
import { unlinkAgent } from '@pagespace/lib/services/agent-ownership';

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

const json = (url: string, body: unknown, ip = IP, headers: Record<string, string> = {}) =>
  new Request(`https://pagespace.test${url}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...headers }, body: JSON.stringify(body) });
const form = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
  new Request('https://pagespace.test/api/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': IP, ...headers }, body: new URLSearchParams(fields).toString() });
const bearer = (url: string, token: string) =>
  new Request(`https://pagespace.test${url}`, { headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': IP } });

interface RegisteredAgent { agentId: string; secret: string; accessToken: string; refreshToken: string }

async function registerAgent(name: string): Promise<RegisteredAgent> {
  const challengeRes = await challengeGET();
  const { challenge, difficulty_bits } = await challengeRes.json() as { challenge: string; difficulty_bits: number };
  const reg = await identityPOST(json('/api/agent/identity', {
    type: 'anonymous', name, source: 'claim-flow-test', tos_accepted: true,
    pow: { challenge, nonce: solvePow(challenge, difficulty_bits) },
  }, randomIp()));
  expect(reg.status).toBe(200);
  const identity = await reg.json() as Record<string, unknown> & { identity_assertion: string; agent_id: string };
  createdUserIds.push(identity.agent_id);
  // No claim token is issued: the agent's own credential is the only one it holds.
  expect(identity).not.toHaveProperty('claim_token');
  const exchanged = await tokenPOST(form({ grant_type: JWT, assertion: identity.identity_assertion, client_id: 'pagespace-agent' }));
  expect(exchanged.status).toBe(200);
  const pair = await exchanged.json() as { access_token: string; refresh_token: string };
  return { agentId: identity.agent_id, secret: identity.identity_assertion, accessToken: pair.access_token, refreshToken: pair.refresh_token };
}

/** Start a claim with a Bearer (the agent's own access token, or whatever an attacker holds). */
async function startClaim(accessToken: string | null, body: unknown = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await claimPOST(json('/api/agent/claim', body, randomIp(), accessToken ? { authorization: `Bearer ${accessToken}` } : {}));
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> };
}

/** Poll the claim grant with a Bearer and optional extra form fields. */
async function poll(accessToken: string | null, extra: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await tokenPOST(form({ grant_type: CLAIM_GRANT, client_id: 'pagespace-agent', ...extra }, accessToken ? { authorization: `Bearer ${accessToken}` } : {}));
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

/** A real `ps_at_` for a HUMAN, account-scoped, as `pagespace login` would hold. */
async function humanAccessToken(userId: string): Promise<string> {
  const { ensureOAuthClientRow } = await import('@/lib/repositories/oauth-repository');
  const cli = getRegisteredClient('pagespace-cli');
  if (!cli) throw new Error('pagespace-cli is not registered');
  const clientDbId = await ensureOAuthClientRow(cli);
  const [user] = await db.select({ tokenVersion: users.tokenVersion }).from(users).where(eq(users.id, userId));
  const tokens = issueInitialTokenPair(new Date(), false);
  await db.insert(oauthAccessTokens).values({
    tokenHash: tokens.accessTokenHash,
    tokenPrefix: tokens.accessTokenPrefix,
    familyId: tokens.familyId,
    clientId: clientDbId,
    userId,
    scopes: ['account'],
    tokenVersion: user?.tokenVersion ?? 0,
    expiresAt: tokens.accessExpiresAt,
  });
  return tokens.accessToken;
}

const TOKEN_FIELDS = ['access_token', 'refresh_token', 'token_type', 'expires_in', 'scope', 'identity_assertion', 'claim_token'];

async function human(name: string): Promise<string> {
  const user = await factories.createUser({ name, accountType: 'human' });
  createdUserIds.push(user.id);
  return user.id;
}

async function identityOf(agentId: string) {
  const [row] = await db
    .select({ ownerUserId: agentIdentities.ownerUserId, claimedAt: agentIdentities.claimedAt, emailVerified: users.emailVerified })
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
  it("start → pending → slow_down → verify → approve → owner set → claimed poll (no tokens) → second poll refused; the agent's own tokens survive", async () => {
    if (!dbAvailable) return;
    const agent = await registerAgent('Claimable Agent');
    const ownerId = await human('Ada Owner');

    // Start, with the agent's own access token.
    const started = await startClaim(agent.accessToken);
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ verification_uri: 'https://pagespace.test/claim', expires_in: 900, interval: 5 });
    const userCode = String(started.body.user_code);
    expect(userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(started.body.verification_uri_complete).toBe(`https://pagespace.test/claim?user_code=${encodeURIComponent(userCode)}`);
    // Stored hash-only, keyed by the agent.
    const [claimRow] = await db.select({ userCodeHash: agentClaims.userCodeHash, agentUserId: agentClaims.agentUserId }).from(agentClaims).where(eq(agentClaims.agentUserId, agent.agentId));
    expect(claimRow).toEqual({ userCodeHash: hashToken(normalizeUserCode(userCode)), agentUserId: agent.agentId });

    // Poll before the human acts: pending, then slow_down when polled again inside the interval.
    expect(await poll(agent.accessToken)).toEqual({ status: 400, body: { error: 'authorization_pending' } });
    expect(await poll(agent.accessToken)).toEqual({ status: 400, body: { error: 'slow_down' } });

    // The human verifies: the screen names the agent.
    const verified = await repo.verifyAgentClaimUserCode({ userCode, claimerUserId: ownerId, now: new Date() });
    expect(verified).toMatchObject({ outcome: 'ok', agent: { agentUserId: agent.agentId, name: 'Claimable Agent', source: 'claim-flow-test' } });

    // Approve.
    expect(await repo.recordAgentClaimDecision({ userCode, action: 'approve', claimerUserId: ownerId, now: new Date() })).toEqual({ outcome: 'approved', agentUserId: agent.agentId });
    const afterApproval = await identityOf(agent.agentId);
    expect(afterApproval.ownerUserId).toBe(ownerId);
    expect(afterApproval.claimedAt).toBeInstanceOf(Date);
    // D-31 option A: the claimed agent may now DM, invite and upload.
    expect(afterApproval.emailVerified).toBeInstanceOf(Date);

    // A claimed agent starts no further claim.
    expect(await startClaim(agent.accessToken)).toEqual({ status: 409, body: { error: 'already_claimed' } });

    // Poll: claimed and the owner — and NOTHING that is a credential.
    const tokensBefore = await db.select({ id: oauthAccessTokens.id }).from(oauthAccessTokens).where(eq(oauthAccessTokens.userId, agent.agentId));
    const claimed = await poll(agent.accessToken);
    expect(claimed).toEqual({ status: 200, body: { claimed: true, owner: { id: ownerId, name: 'Ada Owner' } } });
    const tokensAfter = await db.select({ id: oauthAccessTokens.id }).from(oauthAccessTokens).where(eq(oauthAccessTokens.userId, agent.agentId));
    expect(tokensAfter).toHaveLength(tokensBefore.length);
    const [redeemed] = await db.select({ redeemedAt: agentClaims.redeemedAt }).from(agentClaims).where(eq(agentClaims.agentUserId, agent.agentId));
    expect(redeemed.redeemedAt).toBeInstanceOf(Date);

    // A second poll reports nothing more.
    expect(await poll(agent.accessToken)).toEqual({ status: 400, body: { error: 'invalid_grant' } });

    // Decision 7: the agent's own access AND refresh tokens still work, and now show the owner.
    const me = await meGET(bearer('/api/auth/me', agent.accessToken));
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ id: agent.agentId, accountType: 'agent', agent: { ownerUserId: ownerId } });
    const refreshed = await tokenPOST(form({ grant_type: 'refresh_token', refresh_token: agent.refreshToken, client_id: 'pagespace-agent' }));
    expect(refreshed.status).toBe(200);
  });

  // The security review's HIGH finding, as a regression. Before the fix: anyone
  // holding the claim token T could claim the agent to an account they
  // control, poll the claim grant for the AGENT's ps_at_/ps_rt_, mint mcp_ keys
  // for all its drives and rotate it out; and unlink handed T to the former
  // owner, who could then poll for the agent's tokens while a new owner paid.
  describe('the claim-token takeover chain (security review)', () => {
    it('a claim-token holder starts nothing and polls nothing — with or without a throwaway human', async () => {
      if (!dbAvailable) return;
      const agent = await registerAgent('Takeover Target');
      const throwaway = await human('Mallory Throwaway');
      const throwawayToken = await humanAccessToken(throwaway);
      const T = 'ps_claim_abcdefghijklmnopqrstuvwxyz012345';

      // Step 1 of the old chain: POST /api/agent/claim {claim_token: T}.
      expect((await startClaim(null, { claim_token: T })).status).toBe(401);
      // ...nor with the attacker's own (human) token beside it.
      expect((await startClaim(throwawayToken, { claim_token: T })).status).toBe(404);
      expect((await startClaim(throwawayToken)).status).toBe(404);
      expect(await db.select().from(agentClaims).where(eq(agentClaims.agentUserId, agent.agentId))).toEqual([]);

      // Step 2: poll the claim grant with T — refused before anything is read.
      const withT = await poll(null, { claim_token: T });
      expect(withT).toEqual({ status: 400, body: { error: 'invalid_request' } });
      const asHuman = await poll(throwawayToken);
      expect(asHuman).toEqual({ status: 401, body: { error: 'invalid_token' } });
      for (const field of TOKEN_FIELDS) {
        expect(withT.body).not.toHaveProperty(field);
        expect(asHuman.body).not.toHaveProperty(field);
      }
    });

    it("even when a throwaway human approves a code the agent DID hand out, the poll yields no token — only the agent's own Bearer reads it, and it reads an owner", async () => {
      if (!dbAvailable) return;
      const agent = await registerAgent('Leaked Link Agent');
      const throwaway = await human('Mallory Approver');
      const throwawayToken = await humanAccessToken(throwaway);
      const userCode = String((await startClaim(agent.accessToken)).body.user_code);

      expect((await repo.recordAgentClaimDecision({ userCode, action: 'approve', claimerUserId: throwaway, now: new Date() })).outcome).toBe('approved');

      // The approver cannot poll the agent's claim.
      expect(await poll(throwawayToken)).toEqual({ status: 401, body: { error: 'invalid_token' } });
      // The agent can, and gets only {claimed, owner}.
      const claimed = await poll(agent.accessToken);
      expect(claimed.status).toBe(200);
      for (const field of TOKEN_FIELDS) expect(claimed.body).not.toHaveProperty(field);
    });

    it('a former owner, after unlinking, can start nothing, poll nothing and approve nothing for the agent', async () => {
      if (!dbAvailable) return;
      const agent = await registerAgent('Released Agent');
      const formerOwner = await human('Fran Former');
      const formerToken = await humanAccessToken(formerOwner);

      const firstCode = String((await startClaim(agent.accessToken)).body.user_code);
      expect((await repo.recordAgentClaimDecision({ userCode: firstCode, action: 'approve', claimerUserId: formerOwner, now: new Date() })).outcome).toBe('approved');
      expect((await poll(agent.accessToken)).status).toBe(200);

      // The agent starts a claim (say it wants to move), then the owner unlinks.
      expect((await startClaim(agent.accessToken)).status).toBe(409);
      const unlinked = await unlinkAgent({ ownerUserId: formerOwner, agentUserId: agent.agentId, now: new Date() });
      // Unlink hands back nothing secret.
      expect(unlinked).toEqual({ ok: true });

      // The former owner can neither start nor poll for the agent.
      expect((await startClaim(formerToken)).status).toBe(404);
      expect(await poll(formerToken)).toEqual({ status: 401, body: { error: 'invalid_token' } });

      // The agent re-claims with its own credential; the former owner never sees that code,
      // and an earlier open code (started while unclaimed, then superseded/denied) cannot be approved.
      const reclaim = String((await startClaim(agent.accessToken)).body.user_code);
      const next = await human('Nina Next');
      expect((await repo.recordAgentClaimDecision({ userCode: firstCode, action: 'approve', claimerUserId: formerOwner, now: new Date() })).outcome).toBe('refused');
      expect((await repo.recordAgentClaimDecision({ userCode: reclaim, action: 'approve', claimerUserId: next, now: new Date() })).outcome).toBe('approved');
      expect(await poll(formerToken)).toEqual({ status: 401, body: { error: 'invalid_token' } });
      expect(await poll(agent.accessToken)).toEqual({ status: 200, body: { claimed: true, owner: { id: next, name: 'Nina Next' } } });
    });

    it('unlink denies a code the agent left open, so no one can approve it later', async () => {
      if (!dbAvailable) return;
      const agent = await registerAgent('Open Code Agent');
      const owner = await human('Otto Owner');
      // Claim and settle, unlink, then start (open) and unlink-race: insert an open code directly before a second unlink.
      const code = String((await startClaim(agent.accessToken)).body.user_code);
      expect((await repo.recordAgentClaimDecision({ userCode: code, action: 'approve', claimerUserId: owner, now: new Date() })).outcome).toBe('approved');
      const open = String((await (async () => {
        await db.update(agentIdentities).set({ ownerUserId: null }).where(eq(agentIdentities.userId, agent.agentId));
        const res = await startClaim(agent.accessToken);
        await db.update(agentIdentities).set({ ownerUserId: owner }).where(eq(agentIdentities.userId, agent.agentId));
        return res;
      })()).body.user_code);

      expect(await unlinkAgent({ ownerUserId: owner, agentUserId: agent.agentId, now: new Date() })).toEqual({ ok: true });
      const someone = await human('Sid');
      expect(await repo.recordAgentClaimDecision({ userCode: open, action: 'approve', claimerUserId: someone, now: new Date() })).toMatchObject({ outcome: 'refused', decision: { status: 'already_settled' } });
      expect((await identityOf(agent.agentId)).ownerUserId).toBeNull();
    });
  });

  it('given two humans approving ONE code at the same moment, should settle exactly one owner (FOR UPDATE)', async () => {
    if (!dbAvailable) return;
    const agent = await registerAgent('Contested Agent');
    const [alice, bob] = [await human('Alice'), await human('Bob')];
    const userCode = String((await startClaim(agent.accessToken)).body.user_code);

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
    const userCode = String((await startClaim(target.accessToken)).body.user_code);

    expect(await repo.verifyAgentClaimUserCode({ userCode, claimerUserId: claimer.agentId, now: new Date() })).toEqual({ outcome: 'not_human' });
    const decided = await repo.recordAgentClaimDecision({ userCode, action: 'approve', claimerUserId: claimer.agentId, now: new Date() });
    expect(decided).toMatchObject({ outcome: 'refused', decision: { status: 'not_human' } });
    expect((await identityOf(target.agentId)).ownerUserId).toBeNull();
    expect((await identityOf(target.agentId)).emailVerified).toBeNull();
    // The claim is still pending for a human to approve; another agent cannot poll it.
    expect(await poll(target.accessToken)).toEqual({ status: 400, body: { error: 'authorization_pending' } });
    expect(await poll(claimer.accessToken)).toEqual({ status: 400, body: { error: 'invalid_grant' } });
  });

  it('given a denial, should answer access_denied and let the agent start a fresh claim', async () => {
    if (!dbAvailable) return;
    const agent = await registerAgent('Denied Agent');
    const someone = await human('Dee');
    const userCode = String((await startClaim(agent.accessToken)).body.user_code);

    expect(await repo.recordAgentClaimDecision({ userCode, action: 'deny', claimerUserId: someone, now: new Date() })).toEqual({ outcome: 'denied', agentUserId: agent.agentId });
    expect(await poll(agent.accessToken)).toEqual({ status: 400, body: { error: 'access_denied' } });

    const again = await startClaim(agent.accessToken);
    expect(again.status).toBe(200);
    expect(await poll(agent.accessToken)).toEqual({ status: 400, body: { error: 'authorization_pending' } });
  });

  it('given a second start, should supersede the first code so it can never be approved', async () => {
    if (!dbAvailable) return;
    const agent = await registerAgent('Restarted Agent');
    const someone = await human('Sam');
    const firstCode = String((await startClaim(agent.accessToken)).body.user_code);
    const secondCode = String((await startClaim(agent.accessToken)).body.user_code);
    expect(secondCode).not.toBe(firstCode);

    expect(await repo.verifyAgentClaimUserCode({ userCode: firstCode, claimerUserId: someone, now: new Date() })).toEqual({ outcome: 'not_found' });
    expect(await repo.recordAgentClaimDecision({ userCode: firstCode, action: 'approve', claimerUserId: someone, now: new Date() })).toMatchObject({ outcome: 'refused', decision: { status: 'already_settled' } });
    expect((await repo.verifyAgentClaimUserCode({ userCode: secondCode, claimerUserId: someone, now: new Date() })).outcome).toBe('ok');
  });

  it('given an unlink between approval and poll, should answer access_denied — never a stale grant', async () => {
    if (!dbAvailable) return;
    const agent = await registerAgent('Unlinked Agent');
    const ownerId = await human('Una');
    const userCode = String((await startClaim(agent.accessToken)).body.user_code);
    expect((await repo.recordAgentClaimDecision({ userCode, action: 'approve', claimerUserId: ownerId, now: new Date() })).outcome).toBe('approved');

    expect(await unlinkAgent({ ownerUserId: ownerId, agentUserId: agent.agentId, now: new Date() })).toEqual({ ok: true });

    expect(await poll(agent.accessToken)).toEqual({ status: 400, body: { error: 'access_denied' } });
  });

  it("given a claim started from the agent's SESSION (browser door), should flow through /claim, approval and the bearer poll exactly like a bearer-started one", async () => {
    if (!dbAvailable) return;
    const agent = await registerAgent('Session Agent');
    const ownerId = await human('Sol Owner');
    const { startOwnAgentClaim } = await import('@/lib/agent-auth/claim-start');

    // A bearer-started code is superseded by the session start: one live claim per agent.
    const bearerCode = String((await startClaim(agent.accessToken)).body.user_code);
    const started = await startOwnAgentClaim({ agentUserId: agent.agentId, now: new Date() });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect((await repo.verifyAgentClaimUserCode({ userCode: bearerCode, claimerUserId: ownerId, now: new Date() })).outcome).toBe('not_found');
    expect(await poll(agent.accessToken)).toEqual({ status: 400, body: { error: 'authorization_pending' } });

    expect(await repo.verifyAgentClaimUserCode({ userCode: started.userCode, claimerUserId: ownerId, now: new Date() })).toMatchObject({ outcome: 'ok', agent: { agentUserId: agent.agentId } });
    expect(await repo.recordAgentClaimDecision({ userCode: started.userCode, action: 'approve', claimerUserId: ownerId, now: new Date() })).toEqual({ outcome: 'approved', agentUserId: agent.agentId });
    expect((await identityOf(agent.agentId)).ownerUserId).toBe(ownerId);
    expect((await poll(agent.accessToken)).body).toEqual({ claimed: true, owner: { id: ownerId, name: 'Sol Owner' } });

    // Once claimed, neither door starts another claim.
    expect(await startOwnAgentClaim({ agentUserId: agent.agentId, now: new Date() })).toEqual({ ok: false, error: 'already_claimed' });
    expect((await startClaim(agent.accessToken)).status).toBe(409);
  });

  it('given an agent that never started a claim, should answer invalid_grant on poll', async () => {
    if (!dbAvailable) return;
    const agent = await registerAgent('Quiet Agent');
    expect(await poll(agent.accessToken)).toEqual({ status: 400, body: { error: 'invalid_grant' } });
  });
});
