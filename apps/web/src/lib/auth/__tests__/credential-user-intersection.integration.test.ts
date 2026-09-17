/**
 * The ceiling definition (Sign in with PageSpace, Phase 2b): an explicit-role
 * credential's effective access is the INTERSECTION of what its role grants and
 * what its user can do right now. A credential never exceeds its user.
 *
 * Each scenario grants a drive-scoped `mcp_` key and an OAuth grant the same
 * explicit role, proves the access, then takes the USER's access away — by
 * demotion, by removing their custom role, by revoking a private-page grant —
 * and proves the very next request through the credential lost it too. Real
 * auth door, real resolvers, real Postgres.
 *
 * Requires DATABASE_URL → a migrated Postgres; FAILS LOUDLY when unreachable.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { and, eq } from '@pagespace/db/operators';
import { mcpTokens } from '@pagespace/db/schema/auth';
import { driveMembers, driveRoles, mcpTokenDrives, pagePermissions } from '@pagespace/db/schema/members';
import { oauthAccessTokens, oauthClients } from '@pagespace/db/schema/oauth';
import { factories } from '@pagespace/db/test/factories';
import { generateToken } from '@pagespace/lib/auth/token-utils';
import { ensureTestDb } from '@/test/ensure-test-db';
import {
  authenticateRequestWithOptions,
  isAuthError,
  canPrincipalDeletePage,
  canPrincipalEditPage,
  canPrincipalViewPage,
  isPrincipalDriveOwnerOrAdmin,
  getPrincipalDriveAccessLevel,
  getPrincipalAccessiblePagesInDrive,
  type AuthResult,
} from '@/lib/auth';

type Kind = 'mcp_ key' | 'OAuth grant';
type Row = { role: 'ADMIN' | 'MEMBER'; customRoleId: string | null };

async function credential(kind: Kind, userId: string, driveId: string, row: Row): Promise<string> {
  if (kind === 'mcp_ key') {
    const mcp = generateToken('mcp');
    const [key] = await db.insert(mcpTokens).values({ userId, tokenHash: mcp.hash, tokenPrefix: mcp.tokenPrefix, name: 'intersection key', isScoped: true }).returning();
    await db.insert(mcpTokenDrives).values({ tokenId: key.id, driveId, role: row.role, customRoleId: row.customRoleId });
    return mcp.token;
  }
  const scope = row.customRoleId ? `drive:${driveId}:role:${row.customRoleId}` : `drive:${driveId}:${row.role.toLowerCase()}`;
  const [client] = await db.insert(oauthClients).values({
    clientId: `app_${createId()}`, name: 'Intersection App', clientType: 'public', redirectUris: ['https://intersection.example/callback'],
    allowedGrantTypes: ['authorization_code'], allowedScopes: ['drive', 'drive:admin', 'drive:member'], ownerUserId: userId, verified: false,
  }).returning();
  const access = generateToken('ps_at');
  await db.insert(oauthAccessTokens).values({
    tokenHash: access.hash, tokenPrefix: access.tokenPrefix, familyId: createId(), clientId: client.id, userId,
    scopes: [scope], tokenVersion: 0, expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  });
  return access.token;
}

/** Every call re-authenticates — "the next request", not a cached principal. */
async function principal(token: string): Promise<AuthResult> {
  const auth = await authenticateRequestWithOptions(
    new Request('http://localhost/api/pages', { headers: { authorization: `Bearer ${token}` } }),
    { allow: ['mcp', 'oauth'] },
  );
  if (isAuthError(auth)) throw new Error(`credential did not authenticate (${auth.error.status})`);
  return auth;
}

async function sharedDrive() {
  const owner = await factories.createUser();
  const user = await factories.createUser();
  const drive = await factories.createDrive(owner.id);
  return { ownerId: owner.id, userId: user.id, driveId: drive.id };
}

beforeAll(async () => {
  await ensureTestDb();
});

describe.each<Kind>(['mcp_ key', 'OAuth grant'])('a %s never exceeds its user', (kind) => {
  it('demotion: an explicit-ADMIN credential of a user demoted ADMIN→MEMBER loses admin authority on the next request', async () => {
    const d = await sharedDrive();
    await factories.createDriveMember(d.driveId, d.userId, { role: 'ADMIN' });
    const doc = await factories.createPage(d.driveId, { title: 'Doc', content: 'x' });
    const token = await credential(kind, d.userId, d.driveId, { role: 'ADMIN', customRoleId: null });

    expect(await canPrincipalDeletePage(await principal(token), doc.id)).toBe(true);
    expect(await isPrincipalDriveOwnerOrAdmin(await principal(token), d.driveId)).toBe(true);
    expect((await getPrincipalDriveAccessLevel(await principal(token), d.driveId))?.canShare).toBe(true);

    await db.update(driveMembers).set({ role: 'MEMBER' }).where(and(eq(driveMembers.driveId, d.driveId), eq(driveMembers.userId, d.userId)));

    expect(await canPrincipalDeletePage(await principal(token), doc.id)).toBe(false);
    expect(await isPrincipalDriveOwnerOrAdmin(await principal(token), d.driveId)).toBe(false);
    expect((await getPrincipalDriveAccessLevel(await principal(token), d.driveId))?.canShare).toBe(false);
    // Still what a MEMBER may do.
    expect(await canPrincipalViewPage(await principal(token), doc.id)).toBe(true);
  }, 30_000);

  it('custom role removed from the user: the credential\'s custom-role row stops granting what the user no longer has', async () => {
    const d = await sharedDrive();
    const doc = await factories.createPage(d.driveId, { title: 'Doc', content: 'x' });
    const [role] = await db.insert(driveRoles).values({ driveId: d.driveId, name: `Editors ${createId()}`, permissions: { [doc.id]: { canView: true, canEdit: true, canShare: false } } }).returning();
    await factories.createDriveMember(d.driveId, d.userId, { role: 'MEMBER', customRoleId: role.id });
    const token = await credential(kind, d.userId, d.driveId, { role: 'MEMBER', customRoleId: role.id });

    expect(await canPrincipalEditPage(await principal(token), doc.id)).toBe(true);

    await db.update(driveMembers).set({ customRoleId: null }).where(and(eq(driveMembers.driveId, d.driveId), eq(driveMembers.userId, d.userId)));

    expect(await canPrincipalEditPage(await principal(token), doc.id)).toBe(false);
    const listed = await getPrincipalAccessiblePagesInDrive(await principal(token), d.driveId);
    expect(listed.find((p) => p.id === doc.id)?.permissions.canEdit ?? false).toBe(false);
  }, 30_000);

  it('private-page grant revoked from the user: the credential loses the private page on the next request', async () => {
    const d = await sharedDrive();
    const secret = await factories.createPage(d.driveId, { title: 'Secret', content: 'x', isPrivate: true });
    const [role] = await db.insert(driveRoles).values({ driveId: d.driveId, name: `Secret keepers ${createId()}`, permissions: { [secret.id]: { canView: true, canEdit: true, canShare: false } } }).returning();
    await factories.createDriveMember(d.driveId, d.userId, { role: 'MEMBER' });
    await factories.createPagePermission(secret.id, d.userId, { canView: true, canEdit: true });
    const token = await credential(kind, d.userId, d.driveId, { role: 'MEMBER', customRoleId: role.id });

    expect(await canPrincipalViewPage(await principal(token), secret.id)).toBe(true);
    expect((await getPrincipalAccessiblePagesInDrive(await principal(token), d.driveId)).map((p) => p.id)).toContain(secret.id);

    await db.delete(pagePermissions).where(and(eq(pagePermissions.pageId, secret.id), eq(pagePermissions.userId, d.userId)));

    expect(await canPrincipalViewPage(await principal(token), secret.id)).toBe(false);
    expect((await getPrincipalAccessiblePagesInDrive(await principal(token), d.driveId)).map((p) => p.id)).not.toContain(secret.id);
  }, 30_000);
});
