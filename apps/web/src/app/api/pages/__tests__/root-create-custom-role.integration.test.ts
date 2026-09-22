/**
 * Root-page create under a custom role, against a real Postgres: the drive-wide
 * canEdit rule (#2627) is ONE rule for every principal. A custom role may create
 * at the drive root only when its driveWidePermissions grant edit — for a human
 * member (session), a drive-scoped `mcp_` key and an OAuth `drive:D:role:<id>`
 * grant alike.
 *
 * The key and the grant belong to the drive OWNER, so their user can do
 * everything and the credential's own role is the only thing that can refuse.
 * The human is a MEMBER bound by the same role.
 *
 * Every request runs the REAL route over the REAL authenticateRequestWithOptions,
 * token lookup and permission helpers. Stubbed only: realtime broadcasts, the
 * audit sink, the rate limiter and the two object-storage writes.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { mcpTokens } from '@pagespace/db/schema/auth';
import { driveRoles, mcpTokenDrives } from '@pagespace/db/schema/members';
import { oauthAccessTokens, oauthClients } from '@pagespace/db/schema/oauth';
import { factories } from '@pagespace/db/test/factories';
import { generateToken } from '@pagespace/lib/auth/token-utils';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { ensureTestDb } from '@/test/ensure-test-db';

vi.mock('@/lib/websocket', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/websocket')>()),
  broadcastPageEvent: vi.fn(async () => undefined),
  broadcastDriveEvent: vi.fn(async () => undefined),
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/security/distributed-rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/security/distributed-rate-limit')>()),
  checkDistributedRateLimit: vi.fn(async () => ({ allowed: true, attemptsRemaining: 99 })),
}));
vi.mock('@pagespace/lib/services/page-content-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/services/page-content-store')>()),
  writePageContent: vi.fn(async (content: string, format: string) => {
    const size = Buffer.byteLength(content, 'utf8');
    return { ref: `${format}:root-create`, size, compressed: false, storedSize: size, compressionRatio: 1 };
  }),
}));
vi.mock('@pagespace/lib/services/page-version-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/services/page-version-service')>()),
  createPageVersion: vi.fn(async (input: { content: string }) => {
    const size = Buffer.byteLength(input.content, 'utf8');
    return { id: `v_${Date.now()}`, contentRef: 'root-create', contentSize: size, compressed: false, storedSize: size, compressionRatio: 1 };
  }),
}));

import { POST as pagesPOST } from '../route';

type Principal = 'session' | 'mcp' | 'oauth';

async function customRole(driveId: string, canEdit: boolean): Promise<string> {
  const [role] = await db
    .insert(driveRoles)
    .values({ driveId, name: `role-${createId()}`, permissions: {}, driveWidePermissions: { canView: true, canEdit, canShare: false } })
    .returning();
  return role.id;
}

async function mcpKey(userId: string, driveId: string, customRoleId: string): Promise<string> {
  const token = generateToken('mcp');
  const [key] = await db
    .insert(mcpTokens)
    .values({ userId, tokenHash: token.hash, tokenPrefix: token.tokenPrefix, name: 'custom-role key', isScoped: true })
    .returning();
  await db.insert(mcpTokenDrives).values({ tokenId: key.id, driveId, role: 'MEMBER', customRoleId });
  return token.token;
}

async function oauthRoleGrant(userId: string, driveId: string, customRoleId: string): Promise<string> {
  const [client] = await db
    .insert(oauthClients)
    .values({
      clientId: `app_${createId()}`,
      name: 'Custom Role App',
      clientType: 'public',
      redirectUris: ['https://app.example/callback'],
      allowedGrantTypes: ['authorization_code'],
      allowedScopes: ['drive:member'],
      ownerUserId: userId,
      verified: false,
    })
    .returning();
  const access = generateToken('ps_at');
  await db.insert(oauthAccessTokens).values({
    tokenHash: access.hash,
    tokenPrefix: access.tokenPrefix,
    familyId: createId(),
    clientId: client.id,
    userId,
    scopes: [`drive:${driveId}:role:${customRoleId}`],
    tokenVersion: 0,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  });
  return access.token;
}

async function createRootPage(token: string, driveId: string): Promise<number> {
  const res = await pagesPOST(
    new Request('http://localhost/api/pages', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Root page', type: 'DOCUMENT', driveId }),
    }),
  );
  return res.status;
}

beforeAll(async () => {
  await ensureTestDb();
});

describe.each([
  { roleName: 'view-only drive-wide', canEdit: false, expected: 403 },
  { roleName: 'edit drive-wide', canEdit: true, expected: 201 },
])('root-page create under a custom role with $roleName — one answer for every principal', ({ canEdit, expected }) => {
  const tokens = {} as Record<Principal, string>;
  let driveId: string;

  beforeAll(async () => {
    const owner = await factories.createUser();
    const human = await factories.createUser();
    driveId = (await factories.createDrive(owner.id)).id;
    const roleId = await customRole(driveId, canEdit);
    await factories.createDriveMember(driveId, human.id, { customRoleId: roleId });

    tokens.session = await sessionService.createSession({ userId: human.id, type: 'user', scopes: ['*'], expiresInMs: 15 * 60 * 1000 });
    tokens.mcp = await mcpKey(owner.id, driveId, roleId);
    tokens.oauth = await oauthRoleGrant(owner.id, driveId, roleId);
  });

  it.each<Principal>(['session', 'mcp', 'oauth'])(`given a %s principal, should answer ${expected}`, async (principal) => {
    expect(await createRootPage(tokens[principal], driveId)).toBe(expected);
  });
});
