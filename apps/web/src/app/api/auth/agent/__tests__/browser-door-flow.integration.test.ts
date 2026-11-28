/**
 * The agent BROWSER door end to end, against a REAL Postgres (Agent Signup
 * Phase 3, US2; threat model T2/T3). Every route handler, repository, rate
 * limiter, session and CSRF check is production code — only the audit writer
 * is stubbed.
 *
 *   challenge → solve PoW → browser signup (session cookie, secret once) →
 *   /api/auth/me as the agent → claim link from the session → sign in again
 *   with the secret → wrong / revoked secret both get the identical 401, and
 *   the revoked agent's lockout counter moves.
 *
 * Requires DATABASE_URL → a migrated Postgres. FAILS LOUDLY when none is
 * reachable (requireDb); local runs without one opt out with ALLOW_SKIP_DB_TESTS=1.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.AGENT_SIGNUP_POW_BITS = '8';
  process.env.WEB_APP_URL = 'https://pagespace.test';
  process.env.TRUSTED_PROXY_HOPS = '1';
  process.env.CSRF_SECRET ??= 'browser-door-flow-csrf-secret-at-least-32-chars';
});

vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn(), audit: vi.fn() }));

import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { agentClaims, agentIdentities } from '@pagespace/db/schema/agent-identities';
import { requireDb } from '@pagespace/db/test/require-db';
import { solvePow } from '@pagespace/lib/auth/agent/pow';
import { hashToken } from '@pagespace/lib/auth/token-utils';
import { normalizeUserCode } from '@pagespace/lib/auth/oauth/user-code';
import { revokeAgent } from '@pagespace/lib/services/agent-identities';
import { agentLifecycleStore, sweepAgentLifecycle } from '@pagespace/lib/services/agent-lifecycle';
import { AGENT_UNAUTHENTICATED_TTL_MS } from '@pagespace/lib/auth/agent/lifecycle-decision';

let dbAvailable = false;
const createdUserIds: string[] = [];
const IP = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

type Handler = (req: Request) => Promise<Response>;
let challengeGET: () => Promise<Response>;
let signupPOST: Handler;
let signinPOST: Handler;
let meGET: Handler;
let claimPOST: Handler;
let generateLoginCSRFToken: () => string;

const json = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://pagespace.test${url}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': IP, ...headers }, body: JSON.stringify(body) });

/** `name=value` pairs of every Set-Cookie, as a browser would send them back. */
function cookieHeader(response: Response): string {
  return response.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; ');
}

async function solvedChallenge(): Promise<{ challenge: string; nonce: string }> {
  const res = await challengeGET();
  expect(res.status).toBe(200);
  const body = await res.json() as { challenge: string; difficulty_bits: number };
  return { challenge: body.challenge, nonce: solvePow(body.challenge, body.difficulty_bits) };
}

beforeAll(async () => {
  try {
    await db.select({ id: users.id }).from(users).limit(1);
    dbAvailable = true;
  } catch (error) {
    requireDb('browser-door-flow.integration.test.ts', error);
    dbAvailable = false;
  }
  const challengeRoute = await import('../../../agent/challenge/route');
  challengeGET = () => challengeRoute.GET(new Request('https://pagespace.test/api/agent/challenge', { headers: { 'x-forwarded-for': IP } }));
  signupPOST = (await import('../signup/route')).POST;
  signinPOST = (await import('../signin/route')).POST;
  meGET = (await import('../../me/route')).GET;
  claimPOST = (await import('../../../agent/claim/session/route')).POST;
  generateLoginCSRFToken = (await import('@/lib/auth/login-csrf-utils')).generateLoginCSRFToken;
});

afterAll(async () => {
  if (!dbAvailable || createdUserIds.length === 0) return;
  await db.delete(drives).where(inArray(drives.ownerId, createdUserIds));
  await db.delete(users).where(inArray(users.id, createdUserIds));
});

describe('agent browser door — real Postgres', () => {
  it('signs up with PoW, is signed in as the agent, gets a claim link, and signs in again with the secret', async () => {
    if (!dbAvailable) return;

    const pow = await solvedChallenge();
    const signup = await signupPOST(json('/api/auth/agent/signup', {
      name: 'Browser Flow Agent', source: 'integration-test', tosAccepted: true, pow, csrfToken: generateLoginCSRFToken(), platform: 'web', deviceId: 'browser-flow-device',
    }));
    expect(signup.status).toBe(200);
    const created = await signup.json() as { agentId: string; secret: string; claimToken: string; csrfToken: string; redirectUrl: string };
    createdUserIds.push(created.agentId);
    expect(created.secret).toMatch(/^ps_agent_[a-z0-9]{32}$/);
    expect(created.redirectUrl).toBe('/dashboard');
    const signupCookies = cookieHeader(signup);
    expect(signupCookies).not.toBe('');

    // The same solved challenge cannot create a second agent (T2).
    const replay = await signupPOST(json('/api/auth/agent/signup', { name: 'Replay', tosAccepted: true, pow, csrfToken: generateLoginCSRFToken() }));
    expect(replay.status).toBe(400);

    // The cookie is a real session for the agent.
    const me = await meGET(new Request('https://pagespace.test/api/auth/me', { headers: { cookie: signupCookies } }));
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ id: created.agentId, accountType: 'agent', agent: { ownerUserId: null } });

    // A session-signed-in agent gets a claim link; the row is stored by user-code hash.
    const claim = await claimPOST(new Request('https://pagespace.test/api/agent/claim/session', {
      method: 'POST', headers: { cookie: signupCookies, 'x-csrf-token': created.csrfToken, 'x-forwarded-for': IP },
    }));
    expect(claim.status).toBe(200);
    const link = await claim.json() as { user_code: string; verification_uri_complete: string; expires_in: number };
    expect(link.verification_uri_complete).toBe(`https://pagespace.test/claim?user_code=${link.user_code}`);
    expect(link.expires_in).toBe(900);
    const [claimRow] = await db.select().from(agentClaims).where(eq(agentClaims.userCodeHash, hashToken(normalizeUserCode(link.user_code))));
    expect(claimRow?.agentUserId).toBe(created.agentId);
    expect(claimRow?.ownerUserId).toBeNull();

    // Sign in again with the secret alone.
    const signin = await signinPOST(json('/api/auth/agent/signin', { secret: created.secret, csrfToken: generateLoginCSRFToken(), next: '/dashboard' }));
    expect(signin.status).toBe(200);
    expect(await signin.json()).toMatchObject({ agentId: created.agentId, redirectUrl: '/dashboard' });
    const me2 = await meGET(new Request('https://pagespace.test/api/auth/me', { headers: { cookie: cookieHeader(signin) } }));
    expect(me2.status).toBe(200);

    // An unknown secret and a revoked agent's real secret are indistinguishable (T3).
    const unknown = await signinPOST(json('/api/auth/agent/signin', { secret: `ps_agent_${'q'.repeat(32)}`, csrfToken: generateLoginCSRFToken() }));
    await revokeAgent({ userId: created.agentId, now: new Date() });
    const [before] = await db.select({ failed: users.failedLoginAttempts }).from(users).where(eq(users.id, created.agentId));
    const revoked = await signinPOST(json('/api/auth/agent/signin', { secret: created.secret, csrfToken: generateLoginCSRFToken() }));
    expect(unknown.status).toBe(401);
    expect(revoked.status).toBe(401);
    expect(await revoked.text()).toBe(await unknown.text());
    const [after] = await db.select({ failed: users.failedLoginAttempts }).from(users).where(eq(users.id, created.agentId));
    expect(after.failed).toBe(before.failed + 1);
  });

  // Security review (MEDIUM): browser signup never stamped lastAuthAt, so the
  // 30-day sweep erased a browser-door agent that had only ever used its cookie.
  it('stamps a browser-signed-up agent as authenticated, so the lifecycle sweep keeps it', async () => {
    if (!dbAvailable) return;

    const pow = await solvedChallenge();
    const signup = await signupPOST(json('/api/auth/agent/signup', {
      name: 'Browser Lifecycle Agent', tosAccepted: true, pow, csrfToken: generateLoginCSRFToken(),
    }));
    expect(signup.status).toBe(200);
    const created = await signup.json() as { agentId: string };
    createdUserIds.push(created.agentId);

    const [identity] = await db.select({ lastAuthAt: agentIdentities.lastAuthAt }).from(agentIdentities).where(eq(agentIdentities.userId, created.agentId));
    expect(identity?.lastAuthAt).toBeInstanceOf(Date);

    // Run the sweep as if 31 days had passed, with a recording eraser — and the
    // prunes stubbed, so a shifted clock never deletes other suites' live rows.
    const erased: string[] = [];
    const later = new Date(Date.now() + AGENT_UNAUTHENTICATED_TTL_MS + 24 * 60 * 60 * 1000);
    const store = { ...agentLifecycleStore, pruneExpiredChallenges: async () => 0, pruneExpiredClaims: async () => 0 };
    await sweepAgentLifecycle({ now: later, store, eraseAgent: async (userId) => { erased.push(userId); } });
    expect(erased).not.toContain(created.agentId);
  });
});
