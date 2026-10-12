// @vitest-environment node
/**
 * SEC-2 (two-step sign-in for org members) and SEC-3 (maximum session age), end to end against PostgreSQL.
 *
 * One org sets both rules. The same person reaches it through every credential PageSpace issues — a web session, the
 * CLI's device token (exchanged through the real /api/auth/device/refresh), an MCP token and an OAuth access token —
 * each authenticated by the production request path from the token string alone. For each:
 *   - a single-factor or stale credential is refused the org drive's content with the actionable code;
 *   - the personal drive and the account stay reachable (the rules block org drive access, not the account);
 *   - realtime refuses the same credential: a socket token minted by the real /api/auth/socket-token route, validated
 *     and turned into the socket's actor exactly as apps/realtime does at connect, is refused the join_drive and
 *     document_update resolvers.
 * A passkey re-authentication through the real ceremony routes (/api/auth/step-up/webauthn/options → verify →
 * /api/auth/reauthenticate) restores the web session and, through the device token it re-stamps, the CLI; and when
 * the maximum age elapses the same session is refused again with the reauthentication code.
 *
 * Nothing is faked. The test IS the authenticator: it registers a P-256 passkey and signs each step-up challenge, so the
 * production WebAuthn verifier checks a real signature over real authenticator data (user present AND verified).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { PASSKEY_CONFIG } from '@pagespace/lib/auth/passkey-service';
import { NextRequest } from 'next/server';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { inArray } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { users, mcpTokens, passkeys } from '@pagespace/db/schema/auth';
import { oauthClients } from '@pagespace/db/schema/oauth';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';
import { factories } from '@pagespace/db/test/factories';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { createDeviceTokenRecord } from '@pagespace/lib/auth/device-auth-utils';
import { generateToken, hashToken } from '@pagespace/lib/auth/token-utils';
import { deriveCodeChallenge } from '@pagespace/lib/auth/oauth/pkce';
import type { VerifiedAuthentication } from '@pagespace/lib/auth/authentication-evidence';
import { credentialActor } from '@pagespace/lib/permissions/access-actor';
import { getUserAccessLevel, getUserDriveAccess } from '@pagespace/lib/permissions/permissions';
import { createAuthorizationCode, exchangeAuthorizationCode } from '@/lib/repositories/oauth-repository';


import { GET as getPage } from '@/app/api/pages/[pageId]/route';
import { GET as getAccount } from '@/app/api/account/route';
import { GET as getDrive } from '@/app/api/drives/[driveId]/route';
import { GET as getMe } from '@/app/api/auth/me/route';
import { POST as deviceRefresh } from '@/app/api/auth/device/refresh/route';
import { GET as socketToken } from '@/app/api/auth/socket-token/route';
import { POST as stepUpOptions } from '@/app/api/auth/step-up/webauthn/options/route';
import { POST as stepUpVerify } from '@/app/api/auth/step-up/webauthn/verify/route';
import { GET as reauthBinding, POST as reauthenticate } from '@/app/api/auth/reauthenticate/route';

const MINUTE = 60_000;
const created = { users: [] as string[], orgs: [] as string[], clients: [] as string[] };

const evidence = (assurance: VerifiedAuthentication['assurance'], ageMs = 0): VerifiedAuthentication =>
  ({ authenticatedAtMs: Date.now() - ageMs, assurance });

const bearer = (token: string): HeadersInit => ({ authorization: `Bearer ${token}` });
const json = (body: unknown, token?: string) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? bearer(token) : {}) },
  body: JSON.stringify(body),
});

const openPage = (pageId: string, token: string) =>
  getPage(new Request(`https://app.test/api/pages/${pageId}`, { headers: bearer(token) }), { params: Promise.resolve({ pageId }) });

async function expectRefused(pageId: string, token: string, code: 'org_strong_sign_in_required' | 'org_reauthentication_required') {
  const res = await openPage(pageId, token);
  expect(res.status).toBe(403);
  expect(await res.json()).toMatchObject({ code });
}

const b64url = (bytes: Buffer | Uint8Array) => Buffer.from(bytes).toString('base64url');

/** A software authenticator: one P-256 credential, its COSE public key, and a signature counter. */
function softwareAuthenticator() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x!, 'base64url');
  const y = Buffer.from(jwk.y!, 'base64url');
  // COSE_Key {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}, hand-encoded CBOR.
  const cose = Buffer.concat([Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), x, Buffer.from([0x22, 0x58, 0x20]), y]);
  return { credentialId: b64url(Buffer.from(createId())), publicKeyCose: b64url(cose), privateKey, counter: 0 };
}

/** The assertion a real authenticator returns for `challenge`: user present and verified, counter bumped, signed. */
function assert(device: { credentialId: string; privateKey: KeyObject; counter: number }, challenge: string) {
  device.counter += 1;
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(device.counter);
  const authenticatorData = Buffer.concat([createHash('sha256').update(PASSKEY_CONFIG.rpId).digest(), Buffer.from([0x05]), counter]);
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: PASSKEY_CONFIG.origin, crossOrigin: false }));
  const signature = sign('sha256', Buffer.concat([authenticatorData, createHash('sha256').update(clientDataJSON).digest()]), device.privateKey);
  return {
    id: device.credentialId, rawId: device.credentialId, type: 'public-key', clientExtensionResults: {},
    response: { authenticatorData: b64url(authenticatorData), clientDataJSON: b64url(clientDataJSON), signature: b64url(signature) },
  };
}

async function northwind() {
  const person = await factories.createUser();
  created.users.push(person.id);
  const [org] = await db.insert(organizations).values({
    name: 'Northwind', slug: `nw-${createId()}`, ownerId: person.id,
    policies: { requireStrongSignIn: true, maximumSessionAgeMinutes: 15 },
  }).returning();
  created.orgs.push(org.id);
  await db.insert(orgMembers).values({ orgId: org.id, userId: person.id, role: 'OWNER' });
  const orgDrive = await factories.createDrive(person.id, { orgId: org.id, orgVisibility: 'OPEN' });
  const orgPage = await factories.createPage(orgDrive.id, { title: 'Roadmap', content: 'org secret' });
  const personalDrive = await factories.createDrive(person.id);
  const personalPage = await factories.createPage(personalDrive.id, { title: 'Diary', content: 'my notes' });
  const passkey = softwareAuthenticator();
  await db.insert(passkeys).values({ userId: person.id, credentialId: passkey.credentialId, publicKey: passkey.publicKeyCose, counter: 0 });
  return { person, orgDrive, orgPage, personalDrive, personalPage, passkey };
}

/** The real passkey re-authentication ceremony for `sessionToken`: options → verify → reauthenticate. */
async function reauthenticateWithPasskey(sessionToken: string, passkey: ReturnType<typeof softwareAuthenticator>) {
  const { actionBinding } = await (await reauthBinding(new Request('https://app.test/api/auth/reauthenticate', { headers: bearer(sessionToken) }))).json();
  const options = await stepUpOptions(new NextRequest('https://app.test/api/auth/step-up/webauthn/options', json({ actionBinding }, sessionToken)));
  expect(options.status).toBe(200);
  const { options: challenge } = await options.json();
  const verified = await stepUpVerify(new NextRequest('https://app.test/api/auth/step-up/webauthn/verify', json({
    response: assert(passkey, challenge.challenge),
    expectedChallenge: challenge.challenge,
    actionBinding,
  }, sessionToken)));
  expect(verified.status).toBe(200);
  const { stepUpToken } = await verified.json();
  const res = await reauthenticate(new Request('https://app.test/api/auth/reauthenticate', json({ stepUpToken }, sessionToken)));
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ assurance: 'user_verified_passkey' });
}

/** What apps/realtime does at connect: validate the socket token, keep its claims as the socket's actor. */
async function realtimeActor(sessionToken: string) {
  const res = await socketToken(new Request('https://app.test/api/auth/socket-token', { headers: bearer(sessionToken) }));
  const { token } = await res.json();
  const claims = await sessionService.validateSession(token, { expectedType: 'socket' });
  if (!claims) throw new Error('socket token did not validate');
  return credentialActor(claims.userId, claims.authentication);
}

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for this integration suite');
});

afterEach(async () => {
  vi.useRealTimers();
  if (created.orgs.length) await db.delete(drives).where(inArray(drives.orgId, created.orgs));
  if (created.orgs.length) await db.delete(organizations).where(inArray(organizations.id, created.orgs.splice(0)));
  if (created.clients.length) await db.delete(oauthClients).where(inArray(oauthClients.id, created.clients.splice(0)));
  if (created.users.length) await db.delete(users).where(inArray(users.id, created.users.splice(0)));
});

describe('SEC-2 SEC-3 an org sign-in policy refuses org content to a weak or stale credential of every kind, never the account, and a passkey sign-in restores it', () => {
  it('SEC-2 SEC-3 web session: refused with the code, account and personal drive kept, realtime refused; passkey re-authentication opens it; the maximum age closes it again', async () => {
    const nw = await northwind();
    const session = await sessionService.createSession({ userId: nw.person.id, type: 'user', scopes: ['*'], expiresInMs: 24 * 60 * MINUTE, authentication: evidence('single_factor') });

    await expectRefused(nw.orgPage.id, session, 'org_strong_sign_in_required');
    expect((await openPage(nw.personalPage.id, session)).status).toBe(200);
    expect((await getAccount(new Request('https://app.test/api/account', { headers: bearer(session) }))).status).toBe(200);
    const socket = await realtimeActor(session);
    expect(await getUserDriveAccess(socket, nw.orgDrive.id)).toBe(false); // join_drive
    expect(await getUserAccessLevel(socket, nw.orgPage.id)).toBeNull(); // join_channel / document_update
    expect(await getUserDriveAccess(socket, nw.personalDrive.id)).toBe(true);

    await reauthenticateWithPasskey(session, nw.passkey);
    expect((await openPage(nw.orgPage.id, session)).status).toBe(200);
    expect((await getUserAccessLevel(await realtimeActor(session), nw.orgPage.id))?.canEdit).toBe(true);

    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 16 * MINUTE });
    await expectRefused(nw.orgPage.id, session, 'org_reauthentication_required');
    expect((await openPage(nw.personalPage.id, session)).status).toBe(200);
  });

  it('SEC-2 SEC-3 CLI device token: the session a device refresh issues is refused, and after the person re-authenticates the next refresh opens the org', async () => {
    const nw = await northwind();
    const deviceId = `cli-${createId()}`;
    const device = await createDeviceTokenRecord(nw.person.id, deviceId, 'desktop', nw.person.tokenVersion, { authentication: evidence('single_factor') });
    const refresh = async (deviceToken: string) => {
      const res = await deviceRefresh(new NextRequest('https://app.test/api/auth/device/refresh', json({ deviceToken, deviceId })));
      expect(res.status).toBe(200);
      return (await res.json()) as { sessionToken: string; deviceToken: string };
    };

    const first = await refresh(device.token);
    await expectRefused(nw.orgPage.id, first.sessionToken, 'org_strong_sign_in_required');
    expect((await openPage(nw.personalPage.id, first.sessionToken)).status).toBe(200);
    expect((await getAccount(new Request('https://app.test/api/account', { headers: bearer(first.sessionToken) }))).status).toBe(200);
    expect(await getUserDriveAccess(await realtimeActor(first.sessionToken), nw.orgDrive.id)).toBe(false);

    await reauthenticateWithPasskey(first.sessionToken, nw.passkey);
    const second = await refresh(first.deviceToken);
    expect((await openPage(nw.orgPage.id, second.sessionToken)).status).toBe(200);

    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 16 * MINUTE });
    await expectRefused(nw.orgPage.id, second.sessionToken, 'org_reauthentication_required');
  });

  it('SEC-2 SEC-3 MCP token: a token whose minting sign-in was single-factor or is older than the maximum age is refused with the code; the personal drive stays reachable', async () => {
    const nw = await northwind();
    const mint = async (authentication: VerifiedAuthentication) => {
      const { token, hash, tokenPrefix } = generateToken('mcp');
      await db.insert(mcpTokens).values({
        userId: nw.person.id, tokenHash: hash, tokenPrefix, name: 'cli', isScoped: false,
        authenticatedAt: new Date(authentication.authenticatedAtMs), authenticationAssurance: authentication.assurance,
      });
      return token;
    };
    const weak = await mint(evidence('single_factor'));
    const stale = await mint(evidence('user_verified_passkey', 30 * MINUTE));
    const fresh = await mint(evidence('user_verified_passkey'));

    await expectRefused(nw.orgPage.id, weak, 'org_strong_sign_in_required');
    await expectRefused(nw.orgPage.id, stale, 'org_reauthentication_required');
    expect((await openPage(nw.personalPage.id, weak)).status).toBe(200);
    expect((await openPage(nw.orgPage.id, fresh)).status).toBe(200);
  });

  it('SEC-2 SEC-3 OAuth access token: the consent ceremony\'s evidence travels with the token, so a single-factor or stale consent is refused with the code', async () => {
    const nw = await northwind();
    const redirectUri = 'http://127.0.0.1:12345/callback';
    const verifier = 'v'.repeat(64);
    const [client] = await db.insert(oauthClients).values({ clientId: createId(), name: 'SEC e2e', clientType: 'public', redirectUris: [redirectUri] }).returning();
    created.clients.push(client.id);
    const issue = async (authentication: VerifiedAuthentication) => {
      const code = createId();
      await createAuthorizationCode({
        userId: nw.person.id, clientDbId: client.id, redirectUri, authentication,
        codeChallenge: deriveCodeChallenge(verifier), codeChallengeMethod: 'S256', scopes: ['account'],
        codeHash: hashToken(code), codePrefix: code.slice(0, 12), expiresAt: new Date(Date.now() + MINUTE),
      });
      const exchanged = await exchangeAuthorizationCode({ code, codeVerifier: verifier, redirectUri, clientDbId: client.id, now: new Date() });
      if (exchanged.outcome !== 'ok') throw new Error(`exchange failed: ${exchanged.outcome}`);
      return exchanged.tokens.accessToken;
    };

    // An OAuth client reads drives (the routes that admit OAuth access tokens).
    const openDrive = (driveId: string, token: string) =>
      getDrive(new Request(`https://app.test/api/drives/${driveId}`, { headers: bearer(token) }), { params: Promise.resolve({ driveId }) });
    const refusedDrive = async (token: string, code: string) => {
      const res = await openDrive(nw.orgDrive.id, token);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code });
    };
    const weak = await issue(evidence('single_factor'));
    await refusedDrive(weak, 'org_strong_sign_in_required');
    await refusedDrive(await issue(evidence('user_verified_passkey', 30 * MINUTE)), 'org_reauthentication_required');
    expect((await openDrive(nw.personalDrive.id, weak)).status).toBe(200);
    expect((await getMe(new Request('https://app.test/api/auth/me', { headers: bearer(weak) }))).status).toBe(200);
    expect((await openDrive(nw.orgDrive.id, await issue(evidence('user_verified_passkey')))).status).toBe(200);
  });
});
