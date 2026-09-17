/**
 * Removal and demotion by an org Admin revoke what the membership handed out, against real Postgres
 * (the #2669 review ruling on B7b): removal runs leave's revocation, including OAuth grants that
 * name the org's drives; demotion revokes only what the lower role could not have created.
 *
 * Requires a running Postgres database with the latest migrations applied.
 * Run via:
 *   bun run --filter '@pagespace/lib' test:integration -- src/organizations/__tests__/org-member-revocation.integration.test.ts
 */
import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db, pool } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { factories } from '@pagespace/db/test/factories';
import { mcpTokens } from '@pagespace/db/schema/auth';
import { driveAgentMembers, driveRoles, mcpTokenDrives } from '@pagespace/db/schema/members';
import { oauthAccessTokens, oauthClients, oauthRefreshTokens } from '@pagespace/db/schema/oauth';
import { driveShareLinks, pageShareLinks } from '@pagespace/db/schema/share-links';
import { hashToken } from '../../auth/token-utils';
import { findOAuthAccessTokenByValue } from '../../auth/token-lookup';
import { parseScopeList, scopeSetToDriveScopes } from '../../auth/oauth/scopes';
import { decideRefreshRotation } from '../../auth/oauth/refresh-rotation';
import { getAppAccessLevel, getScopedAccessLevel, hasAppDriveMembership } from '../../permissions/app-permissions';
import { getUserAccessLevel } from '../../permissions/permissions';
import { changeMemberRole, removeMember } from '../membership';
import { cleanupNorthwind, northwind } from '../../permissions/__tests__/fixtures/northwind-org-drives';

const flags = vi.hoisted(() => ({ orgsEnabled: true }));
vi.mock('../../organizations/orgs-enabled', () => ({
  get ORGS_ENABLED() {
    return flags.orgsEnabled;
  },
}));

const createdClientIds: string[] = [];

async function mcpKey(userId: string, scopes: Array<{ driveId: string; role: 'ADMIN' | 'MEMBER' | null }>) {
  const [token] = await db.insert(mcpTokens).values({
    userId, tokenHash: `hash-${createId()}`, tokenPrefix: 'mcp_test', name: 'key', isScoped: true,
  }).returning();
  await db.insert(mcpTokenDrives).values(scopes.map((s) => ({ tokenId: token.id, driveId: s.driveId, role: s.role })));
  return token.id;
}

/** An OAuth token family (one access token, one refresh token) for `scopes`, with the raw access token. */
async function oauthGrant(userId: string, scopes: string[]) {
  const [client] = await db.insert(oauthClients).values({
    clientId: `client-${createId()}`, name: 'Test client', clientType: 'public', redirectUris: ['http://127.0.0.1/callback'],
  }).returning();
  createdClientIds.push(client.id);
  const familyId = createId();
  const accessToken = `ps_at_${createId()}${createId()}`;
  const now = Date.now();
  await db.insert(oauthAccessTokens).values({
    tokenHash: hashToken(accessToken), tokenPrefix: accessToken.slice(0, 12), familyId, clientId: client.id, userId,
    scopes, tokenVersion: 0, expiresAt: new Date(now + 15 * 60_000),
  });
  const [refresh] = await db.insert(oauthRefreshTokens).values({
    tokenHash: hashToken(`ps_rt_${createId()}`), tokenPrefix: 'ps_rt_test', familyId, clientId: client.id, userId,
    scopes, tokenVersion: 0, expiresAt: new Date(now + 30 * 86_400_000), familyExpiresAt: new Date(now + 90 * 86_400_000),
  }).returning();
  const parsed = parseScopeList(scopes.join(' '));
  if (!parsed.ok) throw new Error(`bad scopes ${scopes.join(' ')}`);
  return { accessToken, refreshId: refresh.id, driveScopes: scopeSetToDriveScopes(parsed.scopes) };
}

async function refreshDecision(refreshId: string) {
  const [row] = await db.select().from(oauthRefreshTokens).where(eq(oauthRefreshTokens.id, refreshId));
  return { reason: row.revokedReason, decision: decideRefreshRotation(row, 0, new Date(), false) };
}

async function agentGrant(granterId: string, driveId: string, role: 'ADMIN' | 'MEMBER', customRoleId: string | null = null) {
  const home = await factories.createDrive(granterId, { name: 'Agent home', slug: `agent-home-${createId()}` });
  const agent = await factories.createPage(home.id, { title: 'Agent', type: 'AI_CHAT' });
  const [row] = await db.insert(driveAgentMembers).values({ driveId, agentPageId: agent.id, role, customRoleId, addedBy: granterId }).returning();
  return row.id;
}

async function driveLink(driveId: string, createdBy: string) {
  const [row] = await db.insert(driveShareLinks).values({ driveId, token: `dl-${createId()}`, createdBy }).returning();
  return row.id;
}

async function pageLink(pageId: string, createdBy: string) {
  const [row] = await db.insert(pageShareLinks).values({ pageId, token: `pl-${createId()}`, permissions: ['VIEW'], createdBy }).returning();
  return row.id;
}

async function exists(kind: 'agent' | 'driveLink' | 'pageLink', id: string) {
  const rows = kind === 'agent'
    ? await db.select({ id: driveAgentMembers.id, role: driveAgentMembers.role, customRoleId: driveAgentMembers.customRoleId }).from(driveAgentMembers).where(eq(driveAgentMembers.id, id))
    : kind === 'driveLink'
      ? await db.select({ id: driveShareLinks.id }).from(driveShareLinks).where(eq(driveShareLinks.id, id))
      : await db.select({ id: pageShareLinks.id }).from(pageShareLinks).where(eq(pageShareLinks.id, id));
  return rows[0] ?? null;
}

describe('org member removal and demotion revoke what the membership handed out (integration)', () => {
  afterEach(async () => {
    await cleanupNorthwind();
    const clientIds = createdClientIds.splice(0);
    if (clientIds.length > 0) await db.delete(oauthClients).where(inArray(oauthClients.id, clientIds));
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  it('ORG-4 (partial) an Admin removes a member: their MCP key scopes and OAuth grants on org drives stop resolving, while those on their own drive survive', async () => {
    const f = await northwind();
    const { priya, eve } = f.people;
    const evesNotes = await factories.createDrive(eve.id, { name: 'Eve Notes', slug: `eve-${createId()}` });
    const evesPage = await factories.createPage(evesNotes.id, { title: 'Ideas' });

    // Eve: an inheriting scope on OPEN Product, an explicit MEMBER scope on Research backed by her
    // invited row, and a scope on her own drive; an OAuth grant naming Research and Product, and one
    // naming only her own drive.
    const key = await mcpKey(eve.id, [
      { driveId: f.drives.product.id, role: null },
      { driveId: f.drives.research.id, role: 'MEMBER' },
      { driveId: evesNotes.id, role: null },
    ]);
    const orgGrant = await oauthGrant(eve.id, [`drive:${f.drives.research.id}:member`, `drive:${f.drives.product.id}`]);
    const ownGrant = await oauthGrant(eve.id, [`drive:${evesNotes.id}`]);

    expect(await hasAppDriveMembership(key, f.drives.product.id)).toBe(true);
    expect(await getAppAccessLevel(key, f.pages.researchPage.id)).toMatchObject({ canView: true });
    expect(await findOAuthAccessTokenByValue(orgGrant.accessToken)).not.toBeNull();
    expect(await getScopedAccessLevel(orgGrant.driveScopes, eve.id, f.pages.researchPage.id)).toMatchObject({ canView: true });

    expect(await removeMember({ orgId: f.org.id, actorId: priya.id, targetId: eve.id })).toEqual({ ok: true });

    expect(await hasAppDriveMembership(key, f.drives.product.id)).toBe(false);
    expect(await getAppAccessLevel(key, f.pages.productPage.id)).toBeNull();
    expect(await getAppAccessLevel(key, f.pages.researchPage.id)).toBeNull();
    expect(await findOAuthAccessTokenByValue(orgGrant.accessToken)).toBeNull();
    expect(await refreshDecision(orgGrant.refreshId)).toMatchObject({ reason: 'org_access_revoked', decision: { ok: false } });

    expect(await getAppAccessLevel(key, evesPage.id)).toMatchObject({ canView: true });
    expect(await findOAuthAccessTokenByValue(ownGrant.accessToken)).not.toBeNull();
    expect(await refreshDecision(ownGrant.refreshId)).toMatchObject({ reason: null, decision: { ok: true } });
    // Eve herself keeps what her invited row gives a guest (DRV-8); only what the membership handed out goes.
    expect(await getUserAccessLevel(eve.id, f.pages.researchPage.id)).toMatchObject({ canView: true });
    expect(await getUserAccessLevel(eve.id, f.pages.productPage.id)).toBeNull();
  });

  it('ORG-4 (partial) demoting an Admin to Member revokes only what a Member could not have created: everything on drives org power alone opened, admin-only artifacts on Open drives', async () => {
    const f = await northwind();
    const { jono, priya, omar } = f.people;
    const [contributor] = await db.select({ id: driveRoles.id }).from(driveRoles).where(eq(driveRoles.driveId, f.drives.product.id));
    const productSharedPage = await factories.createPage(f.drives.product.id, { title: 'Launch plan' });
    await factories.createPagePermission(productSharedPage.id, priya.id, { canView: true, canShare: true });

    // Finance (PRIVATE): reached by Priya only through org power.
    const financeAgent = await agentGrant(priya.id, f.drives.finance.id, 'ADMIN');
    const financeDriveLink = await driveLink(f.drives.finance.id, priya.id);
    const financePageLink = await pageLink(f.pages.financePage.id, priya.id);
    const financeKey = await mcpKey(priya.id, [{ driveId: f.drives.finance.id, role: null }]);
    const financeGrant = await oauthGrant(priya.id, [`drive:${f.drives.finance.id}`]);
    // Product (OPEN): as a Member she keeps Contributor reach, which shares nothing.
    const productAdminAgent = await agentGrant(priya.id, f.drives.product.id, 'ADMIN');
    const productContributorAgent = await agentGrant(priya.id, f.drives.product.id, 'MEMBER', contributor.id);
    const productDriveLink = await driveLink(f.drives.product.id, priya.id);
    const productPageLink = await pageLink(f.pages.productPage.id, priya.id);
    const productSharedPageLink = await pageLink(productSharedPage.id, priya.id);
    const productKey = await mcpKey(priya.id, [{ driveId: f.drives.product.id, role: null }]);
    const productGrant = await oauthGrant(priya.id, [`drive:${f.drives.product.id}`]);
    // Omar's invited ADMIN row backs Finance whatever his org role.
    const omarAgent = await agentGrant(omar.id, f.drives.finance.id, 'ADMIN');
    const omarLink = await driveLink(f.drives.finance.id, omar.id);

    expect(await changeMemberRole({ orgId: f.org.id, actorId: jono.id, targetId: priya.id, newRole: 'MEMBER' })).toEqual({ ok: true });
    expect(await changeMemberRole({ orgId: f.org.id, actorId: jono.id, targetId: omar.id, newRole: 'MEMBER' })).toEqual({ ok: true });

    // Finance: all gone, and the key scope and OAuth grant no longer resolve.
    expect(await exists('agent', financeAgent)).toBeNull();
    expect(await exists('driveLink', financeDriveLink)).toBeNull();
    expect(await exists('pageLink', financePageLink)).toBeNull();
    expect(await hasAppDriveMembership(financeKey, f.drives.finance.id)).toBe(false);
    expect(await findOAuthAccessTokenByValue(financeGrant.accessToken)).toBeNull();

    // Product: admin-only artifacts go, Member-creatable ones stay.
    expect(await exists('agent', productAdminAgent)).toEqual({ id: productAdminAgent, role: 'MEMBER', customRoleId: contributor.id });
    expect(await exists('agent', productContributorAgent)).toEqual({ id: productContributorAgent, role: 'MEMBER', customRoleId: contributor.id });
    expect(await exists('driveLink', productDriveLink)).toBeNull();
    expect(await exists('pageLink', productPageLink)).toBeNull();
    expect(await exists('pageLink', productSharedPageLink)).not.toBeNull();
    expect(await hasAppDriveMembership(productKey, f.drives.product.id)).toBe(true);
    expect(await findOAuthAccessTokenByValue(productGrant.accessToken)).not.toBeNull();
    expect(await getUserAccessLevel(priya.id, f.pages.productPage.id)).toMatchObject({ canView: true, canShare: false });

    // Omar: nothing revoked on Finance.
    expect(await exists('agent', omarAgent)).toMatchObject({ role: 'ADMIN' });
    expect(await exists('driveLink', omarLink)).not.toBeNull();
  });

  it('a promotion revokes nothing', async () => {
    const f = await northwind();
    const { jono, marcus } = f.people;
    const link = await pageLink(f.pages.productPage.id, marcus.id);
    const agent = await agentGrant(marcus.id, f.drives.product.id, 'MEMBER');

    expect(await changeMemberRole({ orgId: f.org.id, actorId: jono.id, targetId: marcus.id, newRole: 'ADMIN' })).toEqual({ ok: true });

    expect(await exists('pageLink', link)).not.toBeNull();
    expect(await exists('agent', agent)).toMatchObject({ role: 'MEMBER' });
  });
});
