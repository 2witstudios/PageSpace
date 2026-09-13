/**
 * "Sign in with PageSpace", end to end against a real Postgres — Phase 1a
 * acceptance (epic yv08hib74nrtmksdzxmf5nkw, US1 US2 US8 US9).
 *
 * The real route handlers run in order — authorize POST (consent), token,
 * `/api/auth/me`, a drive route — over the real repository, the real
 * `resolveClient`, the real step-up grant table and the real
 * `validateOAuthAccessToken`. Stubbed only: the browser SESSION (the consent
 * POST's cookie + CSRF; a Bearer request still authenticates for real), the
 * distributed rate limiter, and the audit sink.
 *
 * Requires DATABASE_URL → a migrated Postgres. FAILS LOUDLY when unreachable.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { and, eq } from '@pagespace/db/operators';
import { mcpTokens, verificationTokens } from '@pagespace/db/schema/auth';
import { oauthAccessTokens, oauthClients, oauthRefreshTokens } from '@pagespace/db/schema/oauth';
import { factories } from '@pagespace/db/test/factories';
import { generateToken } from '@pagespace/lib/auth/token-utils';
import { computeActionBindingHash } from '@pagespace/lib/auth/step-up-decisions';
import { deriveCodeChallenge } from '@pagespace/lib/auth/oauth/pkce';
import { ensureTestDb } from '@/test/ensure-test-db';

const session = vi.hoisted(() => ({ userId: '' }));

vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...real,
    // A Bearer request authenticates for real; anything else is the signed-in
    // browser session the consent POST would carry (cookie + CSRF).
    authenticateRequestWithOptions: vi.fn(async (req: Request, options: Parameters<typeof real.authenticateRequestWithOptions>[1]) => {
      if (req.headers.get('authorization')) return real.authenticateRequestWithOptions(req, options);
      return {
        tokenType: 'session' as const,
        userId: session.userId,
        role: 'user' as const,
        tokenVersion: 0,
        adminRoleVersion: 0,
        sessionId: 'integration-session',
      };
    }),
  };
});

vi.mock('@pagespace/lib/security/distributed-rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/security/distributed-rate-limit')>()),
  checkDistributedRateLimit: vi.fn(async () => ({ allowed: true, attemptsRemaining: 99 })),
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));

import { POST as authorizePOST } from '../authorize/route';
import { POST as tokenPOST } from '../token/route';
import { GET as meGET } from '../../auth/me/route';
import { GET as driveGET } from '../../drives/[driveId]/route';
import { validateOAuthAccessToken } from '@/lib/auth';

const REDIRECT_URI = 'https://swipesend.example/auth/pagespace/callback';
const CODE_VERIFIER = 'v'.repeat(64);

async function registerThirdPartyApp(ownerUserId: string): Promise<string> {
  const clientId = `app_${createId()}`;
  await db.insert(oauthClients).values({
    clientId,
    name: 'SwipeSend',
    clientType: 'public',
    redirectUris: [REDIRECT_URI],
    allowedGrantTypes: ['authorization_code', 'refresh_token'],
    allowedScopes: ['profile', 'drive:member', 'offline_access'],
    ownerUserId,
    verified: false,
  });
  return clientId;
}

function consent(clientId: string, scope: string, redirectUri: string, extra: Record<string, unknown> = {}): Request {
  return new Request('http://localhost/api/oauth/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientId,
      redirectUri,
      responseType: 'code',
      codeChallenge: deriveCodeChallenge(CODE_VERIFIER),
      codeChallengeMethod: 'S256',
      scope,
      state: 'st4te',
      action: 'approve',
      ...extra,
    }),
  });
}

function tokenRequest(fields: Record<string, string>): Request {
  return new Request('http://localhost/api/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://swipesend.example' },
    body: new URLSearchParams(fields).toString(),
  });
}

/** A live step-up grant, exactly as the WebAuthn / magic-link ceremony leaves one. */
async function stepUpGrantFor(userId: string, binding: Record<string, string>): Promise<string> {
  const { token, hash, tokenPrefix } = generateToken('ps_stepup');
  await db.insert(verificationTokens).values({
    id: createId(),
    userId,
    tokenHash: hash,
    tokenPrefix,
    type: 'stepup_grant',
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    metadata: JSON.stringify({ actionBindingHash: computeActionBindingHash(binding) }),
  });
  return token;
}

async function codeFrom(res: Response): Promise<string> {
  expect(res.status).toBe(200);
  const location = new URL((await res.json()).redirectUri);
  const code = location.searchParams.get('code');
  expect(code, `consent returned ${location.toString()}`).toBeTruthy();
  return code!;
}

const bearer = (url: string, token: string) => new Request(url, { headers: { authorization: `Bearer ${token}` } });

describe('Sign in with PageSpace — third-party app, real database', () => {
  beforeAll(async () => {
    await ensureTestDb();
  });

  let maya: Awaited<ReturnType<typeof factories.createUser>>;
  let drive: Awaited<ReturnType<typeof factories.createDrive>>;
  let otherDrive: Awaited<ReturnType<typeof factories.createDrive>>;
  let clientId: string;

  beforeEach(async () => {
    const developer = await factories.createUser();
    maya = await factories.createUser();
    drive = await factories.createDrive(maya.id);
    otherDrive = await factories.createDrive(maya.id);
    clientId = await registerThirdPartyApp(developer.id);
    session.userId = maya.id;
  });

  it('US1/US8: profile — no step-up, ps_at_ only, /api/auth/me returns identity, every drive denied', async () => {
    const code = await codeFrom(await authorizePOST(consent(clientId, 'profile', REDIRECT_URI) as never));

    const tokenRes = await tokenPOST(
      tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: CODE_VERIFIER }) as never,
    );
    expect(tokenRes.status).toBe(200);
    const body = await tokenRes.json();
    expect(body.token_type).toBe('Bearer');
    expect(body.access_token).toMatch(/^ps_at_/);
    expect(body).not.toHaveProperty('refresh_token');
    expect(body.scope).toBe('profile');

    const me = await meGET(bearer('http://localhost/api/auth/me', body.access_token));
    expect(me.status).toBe(200);
    // Exactly what profile consent narrates — "name, email, and avatar".
    expect(await me.json()).toStrictEqual({ id: maya.id, name: maya.name, email: maya.email, image: maya.image });

    for (const target of [drive.id, otherDrive.id]) {
      const res = await driveGET(bearer(`http://localhost/api/drives/${target}`, body.access_token), {
        params: Promise.resolve({ driveId: target }),
      });
      expect(res.status).toBe(403);
    }

    const principal = await validateOAuthAccessToken(body.access_token);
    expect(principal?.allowedDriveIds).not.toContain(drive.id);
    expect(principal?.allowedDriveIds.length).toBeGreaterThan(0);

    expect(await db.select({ id: mcpTokens.id }).from(mcpTokens).where(eq(mcpTokens.userId, maya.id))).toEqual([]);
  });

  it('US2: profile drive:X:member offline_access — step-up enforced, ps_at_/ps_rt_ pair, allowedDriveIds === [X], refresh never widens', async () => {
    const scope = `profile drive:${drive.id}:member offline_access`;

    const refused = await authorizePOST(consent(clientId, scope, REDIRECT_URI) as never);
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ error: 'step_up_required' });

    const stepUpToken = await stepUpGrantFor(maya.id, { clientId, redirectUri: REDIRECT_URI, scope, state: 'st4te' });
    const code = await codeFrom(await authorizePOST(consent(clientId, scope, REDIRECT_URI, { stepUpToken }) as never));

    const tokenRes = await tokenPOST(
      tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: CODE_VERIFIER }) as never,
    );
    expect(tokenRes.status).toBe(200);
    const body = await tokenRes.json();
    expect(body.token_type).toBe('Bearer');
    expect(body.access_token).toMatch(/^ps_at_/);
    expect(body.refresh_token).toMatch(/^ps_rt_/);

    const principal = await validateOAuthAccessToken(body.access_token);
    expect(principal?.allowedDriveIds).toEqual([drive.id]);
    expect(principal?.driveScopes).toEqual([{ driveId: drive.id, role: 'MEMBER', customRoleId: null }]);

    const outside = await driveGET(bearer(`http://localhost/api/drives/${otherDrive.id}`, body.access_token), {
      params: Promise.resolve({ driveId: otherDrive.id }),
    });
    expect(outside.status).toBe(403);

    expect(await db.select({ id: mcpTokens.id }).from(mcpTokens).where(eq(mcpTokens.userId, maya.id))).toEqual([]);

    const refreshRes = await tokenPOST(
      tokenRequest({ grant_type: 'refresh_token', refresh_token: body.refresh_token, client_id: clientId }) as never,
    );
    expect(refreshRes.status).toBe(200);
    const refreshed = await refreshRes.json();
    const rotated = await validateOAuthAccessToken(refreshed.access_token);
    expect(rotated?.allowedDriveIds).toEqual([drive.id]);

    const widened = await tokenPOST(
      tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshed.refresh_token, client_id: clientId, scope: `${scope} drive:${otherDrive.id}:member` }) as never,
    );
    expect(widened.status).toBe(400);
  });

  it('US2/ADR 0004 D5: a pure drive:X:member grant with no name: is an OAuth pair for a third party — never an mcp_ key', async () => {
    const scope = `drive:${drive.id}:member offline_access`;
    const stepUpToken = await stepUpGrantFor(maya.id, { clientId, redirectUri: REDIRECT_URI, scope, state: 'st4te' });
    const code = await codeFrom(await authorizePOST(consent(clientId, scope, REDIRECT_URI, { stepUpToken }) as never));

    const tokenRes = await tokenPOST(
      tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: CODE_VERIFIER }) as never,
    );
    expect(tokenRes.status).toBe(200);
    const body = await tokenRes.json();
    expect(body.token_type).toBe('Bearer');
    expect(body.access_token).toMatch(/^ps_at_/);
    expect(body.refresh_token).toMatch(/^ps_rt_/);
    expect((await validateOAuthAccessToken(body.access_token))?.allowedDriveIds).toEqual([drive.id]);
    expect(await db.select({ id: mcpTokens.id }).from(mcpTokens).where(eq(mcpTokens.userId, maya.id))).toEqual([]);
  });

  it('a third-party drive token without profile gets no identity from /api/auth/me', async () => {
    const scope = `drive:${drive.id}:member`;
    const stepUpToken = await stepUpGrantFor(maya.id, { clientId, redirectUri: REDIRECT_URI, scope, state: 'st4te' });
    const code = await codeFrom(await authorizePOST(consent(clientId, scope, REDIRECT_URI, { stepUpToken }) as never));
    const body = await (
      await tokenPOST(
        tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: CODE_VERIFIER }) as never,
      )
    ).json();

    const me = await meGET(bearer('http://localhost/api/auth/me', body.access_token));
    expect(me.status).toBe(403);
    expect(await me.json()).toEqual({ error: 'insufficient_scope' });
  });

  it('disabling a client kills its LIVE access token at once — no 15-minute window', async () => {
    const code = await codeFrom(await authorizePOST(consent(clientId, 'profile', REDIRECT_URI) as never));
    const body = await (
      await tokenPOST(
        tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: CODE_VERIFIER }) as never,
      )
    ).json();
    expect((await meGET(bearer('http://localhost/api/auth/me', body.access_token))).status).toBe(200);

    await db.update(oauthClients).set({ disabledAt: new Date() }).where(eq(oauthClients.clientId, clientId));

    expect((await meGET(bearer('http://localhost/api/auth/me', body.access_token))).status).toBe(401);
  });

  it('pagespace-cli manage_keys login keeps the full /api/auth/me body', async () => {
    const loopback = 'http://127.0.0.1:51234/callback';
    const scope = 'manage_keys offline_access';
    const stepUpToken = await stepUpGrantFor(maya.id, { clientId: 'pagespace-cli', redirectUri: loopback, scope, state: 'st4te' });
    const code = await codeFrom(await authorizePOST(consent('pagespace-cli', scope, loopback, { stepUpToken }) as never));
    const body = await (
      await tokenPOST(
        tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: loopback, client_id: 'pagespace-cli', code_verifier: CODE_VERIFIER }) as never,
      )
    ).json();

    const me = await meGET(bearer('http://localhost/api/auth/me', body.access_token));
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ id: maya.id, email: maya.email, role: 'user', subscriptionTier: 'free' });
  });

  it('a disabled client is refused at the token endpoint exactly like an unknown one', async () => {
    const code = await codeFrom(await authorizePOST(consent(clientId, 'profile', REDIRECT_URI) as never));
    await db.update(oauthClients).set({ disabledAt: new Date() }).where(eq(oauthClients.clientId, clientId));

    const disabled = await tokenPOST(
      tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: CODE_VERIFIER }) as never,
    );
    const unknown = await tokenPOST(
      tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: `app_${createId()}`, code_verifier: CODE_VERIFIER }) as never,
    );

    expect(disabled.status).toBe(400);
    expect(await disabled.json()).toEqual(await unknown.json());
  });

  it('US9: pagespace-cli drive grant still mints an mcp_ key (token_type mcp) and no OAuth rows', async () => {
    const loopback = 'http://127.0.0.1:51234/callback';
    const scope = `drive:${drive.id}:member name:ci-key`;
    const stepUpToken = await stepUpGrantFor(maya.id, { clientId: 'pagespace-cli', redirectUri: loopback, scope, state: 'st4te' });
    const code = await codeFrom(await authorizePOST(consent('pagespace-cli', scope, loopback, { stepUpToken }) as never));

    const tokenRes = await tokenPOST(
      tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: loopback, client_id: 'pagespace-cli', code_verifier: CODE_VERIFIER }) as never,
    );
    expect(tokenRes.status).toBe(200);
    const body = await tokenRes.json();
    expect(body.token_type).toBe('mcp');
    expect(body.access_token).toMatch(/^mcp_/);

    const keys = await db
      .select({ name: mcpTokens.name, isScoped: mcpTokens.isScoped })
      .from(mcpTokens)
      .where(and(eq(mcpTokens.userId, maya.id), eq(mcpTokens.name, 'ci-key')));
    expect(keys).toEqual([{ name: 'ci-key', isScoped: true }]);
    expect(await db.select({ id: oauthAccessTokens.id }).from(oauthAccessTokens).where(eq(oauthAccessTokens.userId, maya.id))).toEqual([]);
    expect(await db.select({ id: oauthRefreshTokens.id }).from(oauthRefreshTokens).where(eq(oauthRefreshTokens.userId, maya.id))).toEqual([]);
  });
});
