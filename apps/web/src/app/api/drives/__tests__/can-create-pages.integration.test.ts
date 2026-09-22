/**
 * GET /api/drives `canCreatePages` for drive-scoped credentials, against a real
 * Postgres. Third-party apps read this flag, so it must never claim a create
 * the real gate refuses: it is the role's drive-wide rule (#2627,
 * resolveDriveWideCanEdit) AND what the credential can do at the drive root
 * right now (the credential ceiling — an explicit role never exceeds its user;
 * an inherited scope is exactly its user).
 *
 * Everything below the door runs for real: token lookup, the principal
 * dispatch, the ceiling resolvers, the custom-role read. Only the audit sink
 * is stubbed. Requires DATABASE_URL → a migrated Postgres.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { mcpTokens } from '@pagespace/db/schema/auth';
import { driveRoles, mcpTokenDrives } from '@pagespace/db/schema/members';
import { oauthAccessTokens, oauthClients } from '@pagespace/db/schema/oauth';
import { factories } from '@pagespace/db/test/factories';
import { generateToken } from '@pagespace/lib/auth/token-utils';
import { ensureTestDb } from '@/test/ensure-test-db';

vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));

import { GET } from '../route';

type KeyRow = { role: 'MEMBER' | 'ADMIN' | null; customRoleId?: string | null };

async function mcpKey(userId: string, driveId: string, row: KeyRow): Promise<string> {
  const token = generateToken('mcp');
  const [key] = await db
    .insert(mcpTokens)
    .values({ userId, tokenHash: token.hash, tokenPrefix: token.tokenPrefix, name: 'canCreatePages key', isScoped: true })
    .returning();
  await db.insert(mcpTokenDrives).values({ tokenId: key.id, driveId, role: row.role, customRoleId: row.customRoleId ?? null });
  return token.token;
}

async function oauthMemberGrant(userId: string, driveId: string): Promise<string> {
  const [client] = await db
    .insert(oauthClients)
    .values({
      clientId: `app_${createId()}`,
      name: 'canCreatePages App',
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
    scopes: [`drive:${driveId}:member`],
    tokenVersion: 0,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  });
  return access.token;
}

async function customRole(driveId: string, canEdit: boolean): Promise<string> {
  const [role] = await db
    .insert(driveRoles)
    .values({
      driveId,
      name: `role-${createId()}`,
      permissions: {},
      driveWidePermissions: { canView: true, canEdit, canShare: false },
    })
    .returning();
  return role.id;
}

async function canCreatePages(token: string, driveId: string): Promise<boolean | undefined> {
  const res = await GET(new Request('http://localhost/api/drives', { headers: { authorization: `Bearer ${token}` } }));
  expect(res.status).toBe(200);
  const body = (await res.json()) as Array<{ id: string; canCreatePages?: boolean }>;
  return body.find((d) => d.id === driveId)?.canCreatePages;
}

beforeAll(async () => {
  await ensureTestDb();
});

describe('GET /api/drives canCreatePages — scoped credentials, real database', () => {
  let driveId: string;
  let editor: string; // plain MEMBER: drive-wide edit
  let viewer: string; // MEMBER bound by a view-only custom role
  let viewOnlyRoleId: string;
  let editRoleId: string;

  beforeAll(async () => {
    const owner = await factories.createUser();
    driveId = (await factories.createDrive(owner.id)).id;
    viewOnlyRoleId = await customRole(driveId, false);
    editRoleId = await customRole(driveId, true);
    editor = (await factories.createUser()).id;
    viewer = (await factories.createUser()).id;
    await factories.createDriveMember(driveId, editor);
    await factories.createDriveMember(driveId, viewer, { customRoleId: viewOnlyRoleId });
  });

  it('given an explicit MEMBER key or grant whose user can edit the drive, should be true', async () => {
    expect(await canCreatePages(await mcpKey(editor, driveId, { role: 'MEMBER' }), driveId)).toBe(true);
    expect(await canCreatePages(await oauthMemberGrant(editor, driveId), driveId)).toBe(true);
  });

  it('given an explicit MEMBER key or grant whose user is bound view-only, should be false — the credential never exceeds its user', async () => {
    expect(await canCreatePages(await mcpKey(viewer, driveId, { role: 'MEMBER' }), driveId)).toBe(false);
    expect(await canCreatePages(await oauthMemberGrant(viewer, driveId), driveId)).toBe(false);
  });

  it('given a key whose explicit custom role has no drive-wide edit, should be false even though its user can edit', async () => {
    expect(await canCreatePages(await mcpKey(editor, driveId, { role: 'MEMBER', customRoleId: viewOnlyRoleId }), driveId)).toBe(false);
  });

  it('given a key whose explicit custom role grants drive-wide edit but whose user is bound view-only, should be false', async () => {
    expect(await canCreatePages(await mcpKey(viewer, driveId, { role: 'MEMBER', customRoleId: editRoleId }), driveId)).toBe(false);
  });

  it('given an inherited key, should follow its user exactly', async () => {
    expect(await canCreatePages(await mcpKey(editor, driveId, { role: null }), driveId)).toBe(true);
    expect(await canCreatePages(await mcpKey(viewer, driveId, { role: null }), driveId)).toBe(false);
  });
});
