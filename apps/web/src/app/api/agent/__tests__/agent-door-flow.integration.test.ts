/**
 * The agent API door end to end, against a REAL Postgres (Agent Signup Phase
 * 2; ADR 0007, threat model T2/T3/T4). Every route handler, repository, rate
 * limiter and auth check here is the production code — only the audit writer
 * is stubbed (it has its own coverage and writes to a separate audit store).
 *
 *   challenge → solve PoW → register → exchange (jwt-bearer) → /api/auth/me
 *   as the agent → refresh → rotate (old secret refused, new one works) →
 *   rotate with revokeExistingTokens (live access token dies).
 *
 * Plus the one replay a unit test cannot prove: the same solved challenge
 * presented twice creates one agent, because consumption is an atomic UPDATE.
 *
 * Requires DATABASE_URL → a migrated Postgres. FAILS LOUDLY when none is
 * reachable (requireDb); local runs without one opt out with ALLOW_SKIP_DB_TESTS=1.
 * Queries are targeted: one agent, a handful of statements per step.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Low difficulty so the solve is instant; read by pow.ts at module load, so it
// is set before any route is imported (the routes are imported dynamically below).
vi.hoisted(() => {
  process.env.AGENT_SIGNUP_POW_BITS = '8';
  process.env.WEB_APP_URL = 'https://pagespace.test';
});

vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn(), audit: vi.fn() }));

import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { agentIdentities } from '@pagespace/db/schema/agent-identities';
import { requireDb } from '@pagespace/db/test/require-db';
import { solvePow } from '@pagespace/lib/auth/agent/pow';

let dbAvailable = false;
const createdUserIds: string[] = [];
// A fresh IP per run: the rate-limit buckets are real rows and outlive the test.
const IP = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const JWT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

type Handler = (req: Request) => Promise<Response>;
let challengeGET: () => Promise<Response>;
let identityPOST: Handler;
let tokenPOST: Handler;
let meGET: Handler;
let rotatePOST: Handler;
let mintPOST: Handler;
let drivesPOST: Handler;

const json = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://pagespace.test${url}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': IP, ...headers }, body: JSON.stringify(body) });
const form = (fields: Record<string, string>) =>
  new Request('https://pagespace.test/api/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': IP }, body: new URLSearchParams(fields).toString() });
const bearer = (url: string, token: string, init: RequestInit = {}) =>
  new Request(`https://pagespace.test${url}`, { ...init, headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': IP, ...(init.headers as Record<string, string> | undefined) } });

async function solvedChallenge(): Promise<{ challenge: string; nonce: string }> {
  const res = await challengeGET();
  expect(res.status).toBe(200);
  const body = await res.json() as { challenge: string; difficulty_bits: number; input: string };
  expect(body.difficulty_bits).toBe(8);
  expect(body.input).toBe(`${body.challenge}:<nonce>`);
  return { challenge: body.challenge, nonce: solvePow(body.challenge, body.difficulty_bits) };
}

const registerBody = (pow: { challenge: string; nonce: string }) => ({ type: 'anonymous', name: 'Flow Agent', source: 'integration-test', tos_accepted: true, pow });

beforeAll(async () => {
  try {
    await db.select({ id: users.id }).from(users).limit(1);
    dbAvailable = true;
  } catch (error) {
    requireDb('agent-door-flow.integration.test.ts', error);
    dbAvailable = false;
  }
  const challengeRoute = await import('../challenge/route');
  challengeGET = () => challengeRoute.GET(new Request('https://pagespace.test/api/agent/challenge', { headers: { 'x-forwarded-for': IP } }));
  identityPOST = (await import('../identity/route')).POST;
  tokenPOST = (await import('../../oauth/token/route')).POST as unknown as Handler;
  meGET = (await import('../../auth/me/route')).GET;
  rotatePOST = (await import('../secret/rotate/route')).POST;
  mintPOST = (await import('../../auth/mcp-tokens/route')).POST as unknown as Handler;
  drivesPOST = (await import('../../drives/route')).POST;
});

afterAll(async () => {
  if (!dbAvailable || createdUserIds.length === 0) return;
  await db.delete(drives).where(inArray(drives.ownerId, createdUserIds));
  await db.delete(users).where(inArray(users.id, createdUserIds));
});

describe('agent API door — real Postgres', () => {
  it('registers, exchanges, acts as itself, refreshes, and rotates its secret', async () => {
    if (!dbAvailable) return;

    // Register.
    const pow = await solvedChallenge();
    const reg = await identityPOST(json('/api/agent/identity', registerBody(pow)));
    expect(reg.status).toBe(200);
    const identity = await reg.json() as { identity_assertion: string; agent_id: string; claim_token: string; grant_type: string; client_id: string; token_endpoint: string };
    createdUserIds.push(identity.agent_id);
    expect(identity.identity_assertion).toMatch(/^ps_agent_[a-z0-9]{32}$/);
    expect(identity.claim_token.startsWith('ps_claim_')).toBe(true);
    expect(identity).toMatchObject({ grant_type: JWT, client_id: 'pagespace-agent', token_endpoint: 'https://pagespace.test/api/oauth/token' });

    // The secret is stored only as a hash.
    const [stored] = await db.select({ secretHash: agentIdentities.secretHash, lastAuthAt: agentIdentities.lastAuthAt }).from(agentIdentities).where(eq(agentIdentities.userId, identity.agent_id));
    expect(stored.secretHash).not.toContain(identity.identity_assertion);
    expect(stored.lastAuthAt).toBeNull();

    // Replaying the consumed challenge creates nothing (T2).
    const replay = await identityPOST(json('/api/agent/identity', registerBody(pow)));
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ error: 'invalid_request' });

    // Exchange the secret (jwt-bearer).
    const exchanged = await tokenPOST(form({ grant_type: JWT, assertion: identity.identity_assertion, client_id: 'pagespace-agent' }));
    expect(exchanged.status).toBe(200);
    const pair = await exchanged.json() as { access_token: string; refresh_token: string; scope: string; token_type: string };
    expect(pair.access_token.startsWith('ps_at_')).toBe(true);
    expect(pair.refresh_token.startsWith('ps_rt_')).toBe(true);
    expect(pair).toMatchObject({ token_type: 'Bearer', scope: 'account offline_access' });
    const [afterAuth] = await db.select({ lastAuthAt: agentIdentities.lastAuthAt }).from(agentIdentities).where(eq(agentIdentities.userId, identity.agent_id));
    expect(afterAuth.lastAuthAt).not.toBeNull();

    // pagespace-cli can never redeem the agent secret; a drive scope is refused.
    const viaCli = await tokenPOST(form({ grant_type: JWT, assertion: identity.identity_assertion, client_id: 'pagespace-cli' }));
    expect(await viaCli.json()).toEqual({ error: 'unauthorized_client' });
    const driveScope = await tokenPOST(form({ grant_type: JWT, assertion: identity.identity_assertion, client_id: 'pagespace-agent', scope: 'drive:abc123' }));
    expect(await driveScope.json()).toEqual({ error: 'invalid_grant' });

    // Use the API as itself.
    const me = await meGET(bearer('/api/auth/me', pair.access_token));
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ id: identity.agent_id, accountType: 'agent', emailVerified: null, agent: { ownerUserId: null, source: 'integration-test' } });

    // ADR 0007 D6: mint its own mcp_ key with its own grant's token, then use
    // that key for a content write the ps_at_ itself may not make.
    const minted = await mintPOST(bearer('/api/auth/mcp-tokens', pair.access_token, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'flow key' }) }));
    expect(minted.status).toBe(200);
    const { token: mcpKey } = await minted.json() as { token: string };
    expect(mcpKey.startsWith('mcp_')).toBe(true);
    const viaAccessToken = await drivesPOST(bearer('/api/drives', pair.access_token, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Not via ps_at_' }) }));
    expect(viaAccessToken.status).toBe(401);
    const created = await drivesPOST(bearer('/api/drives', mcpKey, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Agent Drive' }) }));
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ name: 'Agent Drive', ownerId: identity.agent_id });

    // Refresh through the existing rotation, unchanged.
    const refreshed = await tokenPOST(form({ grant_type: 'refresh_token', refresh_token: pair.refresh_token, client_id: 'pagespace-agent' }));
    expect(refreshed.status).toBe(200);
    const pair2 = await refreshed.json() as { access_token: string; refresh_token: string };
    expect(pair2.access_token).not.toBe(pair.access_token);

    // Rotate the secret with the agent's own ps_at_ (no tokenVersion bump).
    const rotated = await rotatePOST(bearer('/api/agent/secret/rotate', pair2.access_token, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) }));
    expect(rotated.status).toBe(200);
    const rotation = await rotated.json() as { identity_assertion: string; secret_version: number };
    expect(rotation.secret_version).toBe(2);
    expect(rotation.identity_assertion).not.toBe(identity.identity_assertion);

    // Old secret refused, new one works, live token still works.
    const oldSecret = await tokenPOST(form({ grant_type: JWT, assertion: identity.identity_assertion, client_id: 'pagespace-agent' }));
    expect(oldSecret.status).toBe(400);
    expect(await oldSecret.json()).toEqual({ error: 'invalid_grant' });
    const newSecret = await tokenPOST(form({ grant_type: JWT, assertion: rotation.identity_assertion, client_id: 'pagespace-agent' }));
    expect(newSecret.status).toBe(200);
    const pair3 = await newSecret.json() as { access_token: string };
    expect((await meGET(bearer('/api/auth/me', pair2.access_token))).status).toBe(200);

    // Rotate again revoking existing tokens: the live access token dies.
    const revoking = await rotatePOST(bearer('/api/agent/secret/rotate', pair3.access_token, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revokeExistingTokens: true }) }));
    expect(revoking.status).toBe(200);
    expect((await revoking.json() as { revoked_existing_tokens: boolean }).revoked_existing_tokens).toBe(true);
    expect((await meGET(bearer('/api/auth/me', pair3.access_token))).status).toBe(401);
  });

  it('given one solved challenge submitted twice CONCURRENTLY, should create exactly one agent (atomic consume, T2)', async () => {
    if (!dbAvailable) return;
    const pow = await solvedChallenge();
    // Both requests pass the route's lookup before either commits; only the
    // `UPDATE … WHERE consumedAt IS NULL` inside createAgentAccount decides.
    const raceIp = { 'x-forwarded-for': `${IP}.race` };
    const [a, b] = await Promise.all([
      identityPOST(json('/api/agent/identity', registerBody(pow), raceIp)),
      identityPOST(json('/api/agent/identity', registerBody(pow), raceIp)),
    ]);
    const bodies = await Promise.all([a.json(), b.json()]) as Array<{ agent_id?: string }>;
    for (const body of bodies) if (body.agent_id) createdUserIds.push(body.agent_id);
    expect([a.status, b.status].sort()).toEqual([200, 400]);
  });

  it('refuses a caller naming an id that is not an agent it is or owns, with the same 404 (no oracle)', async () => {
    if (!dbAvailable) return;
    // A second agent rotating the first agent's secret is "anyone else".
    const pow = await solvedChallenge();
    const reg = await identityPOST(json('/api/agent/identity', registerBody(pow)));
    const other = await reg.json() as { identity_assertion: string; agent_id: string };
    createdUserIds.push(other.agent_id);
    const tokenRes = await tokenPOST(form({ grant_type: JWT, assertion: other.identity_assertion, client_id: 'pagespace-agent' }));
    const { access_token } = await tokenRes.json() as { access_token: string };
    const res = await rotatePOST(bearer('/api/agent/secret/rotate', access_token, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: createId() }) }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});
