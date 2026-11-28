// @vitest-environment node
/**
 * Re-authenticating the current session — REAL Postgres (D-OW-45; SEC-2/SEC-3 partial).
 *
 * The route consumes a real single-use step-up grant (as verifyWebauthnStepUp / completeMagicLinkStepUp mint it after
 * verifying the ceremony — WebAuthn itself cannot run here, so the grant row is written the way the verifier writes
 * it) and stamps its evidence onto the real session row; the org's sign-in policy then admits the session it refused.
 * Only authentication of the request is faked (it returns the claims of the real session).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { deviceTokens, users, verificationTokens } from '@pagespace/db/schema/auth';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';
import { factories } from '@pagespace/db/test/factories';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { createDeviceTokenRecord } from '@pagespace/lib/auth/device-auth-utils';
import { computeActionBindingHash } from '@pagespace/lib/auth/step-up-decisions';
import { generateToken } from '@pagespace/lib/auth/token-utils';
import { checkActorDriveAuthentication } from '@pagespace/lib/permissions/actor-authentication';
import { credentialActor } from '@pagespace/lib/permissions/access-actor';
import type { VerifiedAuthentication } from '@pagespace/lib/auth/authentication-evidence';

const authState = vi.hoisted(() => ({ result: null as unknown }));
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(async () => authState.result),
  isAuthError: (r: unknown) => typeof r === 'object' && r !== null && 'error' in r,
}));
vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: vi.fn(async () => ({ allowed: true })),
  DISTRIBUTED_RATE_LIMITS: { PASSKEY_AUTH: {} },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));

import { POST, GET } from '../route';
import { reauthenticationActionBinding } from '@/lib/auth/reauthentication-binding';

const userIds: string[] = [];
const orgIds: string[] = [];
const DEVICE = 'device-laptop';

const ago = (minutes: number, assurance: VerifiedAuthentication['assurance']): VerifiedAuthentication =>
  ({ authenticatedAtMs: Date.now() - minutes * 60_000, assurance });

async function fixture(current: VerifiedAuthentication | null) {
  const owner = await factories.createUser();
  userIds.push(owner.id);
  const [org] = await db.insert(organizations).values({
    name: 'Policy test', slug: createId(), ownerId: owner.id, policies: { requireStrongSignIn: true, maximumSessionAgeMinutes: 60 },
  }).returning();
  orgIds.push(org.id);
  await db.insert(orgMembers).values({ orgId: org.id, userId: owner.id, role: 'OWNER' });
  const drive = await factories.createDrive(owner.id, { orgId: org.id, orgVisibility: 'OPEN' });
  const token = await sessionService.createSession({ userId: owner.id, authentication: current, type: 'user', scopes: ['*'], expiresInMs: 86_400_000, deviceId: DEVICE });
  await createDeviceTokenRecord(owner.id, DEVICE, 'web', 0, { authentication: current });
  const claims = await sessionService.validateSession(token);
  if (!claims) throw new Error('session did not validate');
  authState.result = { tokenType: 'session', userId: owner.id, sessionId: claims.sessionId, role: 'user', tokenVersion: 0, adminRoleVersion: 0, authentication: claims.authentication };
  return { owner, drive, token, sessionId: claims.sessionId };
}

/** The grant row a step-up verifier writes once the ceremony checked out. */
async function grant(userId: string, actionBinding: Record<string, string>, authentication: VerifiedAuthentication) {
  const { token, hash, tokenPrefix } = generateToken('ps_stepup');
  await db.insert(verificationTokens).values({
    id: createId(), userId, tokenHash: hash, tokenPrefix, type: 'stepup_grant', expiresAt: new Date(Date.now() + 5 * 60_000),
    metadata: JSON.stringify({ actionBindingHash: computeActionBindingHash(actionBinding), authentication }),
  });
  return token;
}

const post = (stepUpToken: string) =>
  POST(new Request('https://example.test/api/auth/reauthenticate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stepUpToken }) }));

const evidenceOf = async (token: string) => (await sessionService.validateSession(token))?.authentication ?? null;

beforeEach(() => {
  authState.result = null;
});

afterEach(async () => {
  if (orgIds.length) await db.delete(drives).where(inArray(drives.orgId, orgIds));
  if (orgIds.length) await db.delete(organizations).where(inArray(organizations.id, orgIds.splice(0)));
  if (userIds.length) await db.delete(users).where(inArray(users.id, userIds.splice(0)));
});

describe('re-authenticating the current session against PostgreSQL (D-OW-45)', () => {
  it('SEC-2 (partial) a user-verified passkey ceremony stamps fresh strong evidence on the session and its device token, and the org drive opens', async () => {
    const f = await fixture(ago(5, 'single_factor'));
    expect(await checkActorDriveAuthentication(credentialActor(f.owner.id, await evidenceOf(f.token)), f.drive.id)).toEqual({ allowed: false, code: 'org_strong_sign_in_required' });

    const { actionBinding } = await (await GET(new Request('https://example.test/api/auth/reauthenticate'))).json();
    expect(actionBinding).toEqual(reauthenticationActionBinding(f.sessionId));
    const res = await post(await grant(f.owner.id, actionBinding, ago(0, 'user_verified_passkey')));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ assurance: 'user_verified_passkey' });
    const stamped = await evidenceOf(f.token);
    expect(stamped).toMatchObject({ assurance: 'user_verified_passkey' });
    expect(Date.now() - (stamped?.authenticatedAtMs ?? 0)).toBeLessThan(60_000);
    expect(await checkActorDriveAuthentication(credentialActor(f.owner.id, stamped), f.drive.id)).toEqual({ allowed: true });
    const [device] = await db.select().from(deviceTokens).where(and(eq(deviceTokens.userId, f.owner.id), eq(deviceTokens.deviceId, DEVICE)));
    expect(device.authenticationAssurance).toBe('user_verified_passkey');
  });

  it('SEC-3 (partial) a stale credential from before evidence existed is refused, then a fresh ceremony restores access', async () => {
    const f = await fixture(null);
    expect(await checkActorDriveAuthentication(credentialActor(f.owner.id, await evidenceOf(f.token)), f.drive.id)).toEqual({ allowed: false, code: 'org_strong_sign_in_required' });
    expect((await post(await grant(f.owner.id, reauthenticationActionBinding(f.sessionId), ago(0, 'user_verified_passkey')))).status).toBe(200);
    expect(await checkActorDriveAuthentication(credentialActor(f.owner.id, await evidenceOf(f.token)), f.drive.id)).toEqual({ allowed: true });
  });

  it('SEC-2 (partial) the grant is single-use and bound to this session: another session\'s grant, a replay or a forged token change nothing', async () => {
    const f = await fixture(ago(5, 'single_factor'));
    const elsewhere = await grant(f.owner.id, reauthenticationActionBinding(createId()), ago(0, 'user_verified_passkey'));
    expect((await post(elsewhere)).status).toBe(401);
    expect((await post('ps_stepup_forged')).status).toBe(401);

    const mine = await grant(f.owner.id, reauthenticationActionBinding(f.sessionId), ago(0, 'single_factor'));
    expect((await post(mine)).status).toBe(200);
    expect((await post(mine)).status).toBe(401);
    expect(await evidenceOf(f.token)).toMatchObject({ assurance: 'single_factor' });
  });

  it('SEC-2 (partial) an emailed-link ceremony never downgrades a passkey session (409, unchanged)', async () => {
    const before = ago(90, 'user_verified_passkey');
    const f = await fixture(before);
    const res = await post(await grant(f.owner.id, reauthenticationActionBinding(f.sessionId), ago(0, 'single_factor')));
    expect(res.status).toBe(409);
    expect(await evidenceOf(f.token)).toEqual(before);
  });
});
