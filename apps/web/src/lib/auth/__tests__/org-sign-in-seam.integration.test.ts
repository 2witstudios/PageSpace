// @vitest-environment node
/**
 * D-OW-45: the ONE enforcement seam for an org's sign-in policy (SEC-2 strong sign-in, SEC-3 maximum session age),
 * end to end against PostgreSQL. Every credential here is REAL — a session token or an MCP token minted into the
 * database with its ceremony evidence, authenticated by the production request path — and every surface reads org
 * content through the actor-taking access API: a page route, file view/download, the SQL readers behind search and
 * pulse, AI tool reads and writes, the resolvers the realtime joins and document_update re-checks call, and the
 * service token the processor re-checks with. Only the S3 presigner is faked.
 *
 * The same person keeps their personal drive and their account through a refused credential, and a fresh passkey
 * credential for that person opens the org content.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { drives, pages } from '@pagespace/db/schema/core';
import { users, mcpTokens } from '@pagespace/db/schema/auth';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';
import { factories } from '@pagespace/db/test/factories';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { generateToken } from '@pagespace/lib/auth/token-utils';
import type { VerifiedAuthentication } from '@pagespace/lib/auth/authentication-evidence';
import { credentialActor, type AccessActor } from '@pagespace/lib/permissions/access-actor';
import { accessiblePageIds } from '@pagespace/lib/permissions/accessible-page-ids';
import { getMemberDriveIds } from '@pagespace/lib/permissions/member-drives';
import { getBatchPagePermissions, getUserAccessLevel, getUserDriveAccess } from '@pagespace/lib/permissions/permissions';
import { listAccessibleDrives } from '@pagespace/lib/services/drive-service';
import { createPageServiceToken } from '@pagespace/lib/services/validated-service-token';
import { EnforcedAuthContext } from '@pagespace/lib/permissions/enforced-context';
import type { ToolExecutionContext } from '@/lib/ai/core/types';

vi.mock('@/lib/presigned-url', () => ({
  generatePresignedUrl: vi.fn(async () => 'https://storage.test/presigned'),
  getPresignedUrlTtl: vi.fn(() => 60),
}));

import { GET as getPage } from '@/app/api/pages/[pageId]/route';
import { GET as viewFile } from '@/app/api/files/[id]/view/route';
import { GET as downloadFile } from '@/app/api/files/[id]/download/route';
import { pageReadTools } from '@/lib/ai/tools/page-read-tools';
import { pageWriteTools } from '@/lib/ai/tools/page-write-tools';

const HOUR = 3_600_000;
const created = { users: [] as string[], orgs: [] as string[] };

const evidence = (assurance: VerifiedAuthentication['assurance'], ageMs = 0): VerifiedAuthentication =>
  ({ authenticatedAtMs: Date.now() - ageMs, assurance });

async function mintSession(userId: string, authentication: VerifiedAuthentication): Promise<string> {
  return sessionService.createSession({ userId, type: 'user', scopes: ['*'], expiresInMs: HOUR, authentication });
}

async function mintMcpToken(userId: string, authentication: VerifiedAuthentication): Promise<string> {
  const { token, hash, tokenPrefix } = generateToken('mcp');
  await db.insert(mcpTokens).values({
    userId, tokenHash: hash, tokenPrefix, name: 'seam', isScoped: false,
    authenticatedAt: new Date(authentication.authenticatedAtMs), authenticationAssurance: authentication.assurance,
  });
  return token;
}

/** The actor the production session path builds from a minted token: its claims' user and evidence. */
async function actorOf(sessionToken: string): Promise<AccessActor> {
  const claims = await sessionService.validateSession(sessionToken, { expectedType: 'user' });
  if (!claims) throw new Error('session did not validate');
  return EnforcedAuthContext.fromSession(claims).actor;
}

async function northwind(policies: Record<string, unknown>) {
  const person = await factories.createUser();
  created.users.push(person.id);
  const [org] = await db.insert(organizations).values({ name: 'Northwind', slug: `nw-${createId()}`, ownerId: person.id, policies }).returning();
  created.orgs.push(org.id);
  await db.insert(orgMembers).values({ orgId: org.id, userId: person.id, role: 'OWNER' });
  const orgDrive = await factories.createDrive(person.id, { orgId: org.id, orgVisibility: 'OPEN' });
  const orgPage = await factories.createPage(orgDrive.id, { title: 'Roadmap', content: 'org secret' });
  const orgFile = await factories.createPage(orgDrive.id, { type: 'FILE', title: 'plan.pdf', filePath: `files/${'a'.repeat(64)}/original`, mimeType: 'application/pdf' });
  const personalDrive = await factories.createDrive(person.id);
  const personalPage = await factories.createPage(personalDrive.id, { title: 'Diary', content: 'my notes' });
  const personalFile = await factories.createPage(personalDrive.id, { type: 'FILE', title: 'me.pdf', filePath: `files/${'b'.repeat(64)}/original`, mimeType: 'application/pdf' });
  return { person, org, orgDrive, orgPage, orgFile, personalDrive, personalPage, personalFile };
}

const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
const pageRequest = (pageId: string, token: string) =>
  getPage(new Request(`https://app.test/api/pages/${pageId}`, bearer(token)), { params: Promise.resolve({ pageId }) });
const fileRequest = (handler: typeof viewFile, id: string, token: string) =>
  handler(new NextRequest(`https://app.test/api/files/${id}/view`, { headers: { ...bearer(token).headers, accept: 'application/json' } }), { params: Promise.resolve({ id }) });

const toolContext = (actor: AccessActor): ToolExecutionContext => ({ userId: actor.userId, accessActor: actor });
const toolOptions = (context: ToolExecutionContext) => ({ toolCallId: createId(), messages: [], experimental_context: context });
/** A tool's answer or its refusal, as the model would see it (a tool reports a denial by throwing). */
const outcome = (run: unknown): Promise<string> => Promise.resolve(run).then((result) => JSON.stringify(result), (error: unknown) => `refused: ${String(error)}`);

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for this integration suite');
});

afterEach(async () => {
  if (created.orgs.length) await db.delete(drives).where(inArray(drives.orgId, created.orgs));
  if (created.orgs.length) await db.delete(organizations).where(inArray(organizations.id, created.orgs.splice(0)));
  if (created.users.length) await db.delete(users).where(inArray(users.id, created.users.splice(0)));
});

describe('SEC-2 (partial) SEC-3 (partial) the org sign-in policy, through the one access seam, against PostgreSQL', () => {
  it('SEC-2 (partial) a page route refuses a magic-link session org content with the strong-sign-in code, keeps the personal drive, and admits a passkey session', async () => {
    const nw = await northwind({ requireStrongSignIn: true });
    const magicLink = await mintSession(nw.person.id, evidence('single_factor'));
    const passkey = await mintSession(nw.person.id, evidence('user_verified_passkey'));

    const refused = await pageRequest(nw.orgPage.id, magicLink);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'org_strong_sign_in_required' });

    expect((await pageRequest(nw.personalPage.id, magicLink)).status).toBe(200);
    expect((await pageRequest(nw.orgPage.id, passkey)).status).toBe(200);
  });

  it('SEC-3 (partial) an MCP token older than the org maximum age is refused with the reauthentication code; a fresh one is not', async () => {
    const nw = await northwind({ maximumSessionAgeMinutes: 60 });
    const stale = await mintMcpToken(nw.person.id, evidence('user_verified_passkey', 2 * HOUR));
    const fresh = await mintMcpToken(nw.person.id, evidence('single_factor'));

    const refused = await pageRequest(nw.orgPage.id, stale);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'org_reauthentication_required' });
    expect((await pageRequest(nw.personalPage.id, stale)).status).toBe(200);
    expect((await pageRequest(nw.orgPage.id, fresh)).status).toBe(200);
  });

  it('SEC-2 (partial) file view and download refuse org files to a magic-link session with the code and serve personal files', async () => {
    const nw = await northwind({ requireStrongSignIn: true });
    const magicLink = await mintSession(nw.person.id, evidence('single_factor'));
    const passkey = await mintSession(nw.person.id, evidence('user_verified_passkey'));

    for (const handler of [viewFile, downloadFile]) {
      const refused = await fileRequest(handler, nw.orgFile.id, magicLink);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ code: 'org_strong_sign_in_required' });
      expect((await fileRequest(handler, nw.personalFile.id, magicLink)).status).not.toBe(403);
      expect((await fileRequest(handler, nw.orgFile.id, passkey)).status).not.toBe(403);
    }
  });

  it('SEC-3 (partial) the SQL readers behind search and pulse drop a stale credential\'s org pages and drives, not its personal ones', async () => {
    const nw = await northwind({ maximumSessionAgeMinutes: 30 });
    const stale = await actorOf(await mintSession(nw.person.id, evidence('user_verified_passkey', HOUR)));
    const fresh = await actorOf(await mintSession(nw.person.id, evidence('single_factor')));

    const stalePages = await accessiblePageIds(stale);
    expect(stalePages).not.toContain(nw.orgPage.id);
    expect(stalePages).toContain(nw.personalPage.id);
    expect(await accessiblePageIds(fresh)).toContain(nw.orgPage.id);

    const staleDrives = await getMemberDriveIds(stale, { includeTrashed: false });
    expect(staleDrives).not.toContain(nw.orgDrive.id);
    expect(staleDrives).toContain(nw.personalDrive.id);
    expect((await listAccessibleDrives(stale)).map((d) => d.id)).not.toContain(nw.orgDrive.id);

    const batch = await getBatchPagePermissions(stale, [nw.orgPage.id, nw.personalPage.id]);
    expect(batch.get(nw.orgPage.id)?.canView).toBe(false);
    expect(batch.get(nw.personalPage.id)?.canView).toBe(true);
  });

  it('SEC-2 (partial) an AI tool driven by a magic-link session can neither read nor write an org page; a passkey session reads it', async () => {
    const nw = await northwind({ requireStrongSignIn: true });
    const magicLink = toolContext(await actorOf(await mintSession(nw.person.id, evidence('single_factor'))));
    const passkey = toolContext(await actorOf(await mintSession(nw.person.id, evidence('user_verified_passkey'))));
    const readPage = pageReadTools.read_page.execute!;
    const renamePage = pageWriteTools.rename_page.execute!;

    const refusedRead = await outcome(readPage({ title: 'Roadmap', pageId: nw.orgPage.id }, toolOptions(magicLink)));
    expect(refusedRead).toMatch(/^refused: .*Insufficient permissions/);
    expect(refusedRead).not.toContain('org secret');
    expect(await outcome(readPage({ title: 'Diary', pageId: nw.personalPage.id }, toolOptions(magicLink)))).toContain('my notes');
    expect(await outcome(readPage({ title: 'Roadmap', pageId: nw.orgPage.id }, toolOptions(passkey)))).toContain('org secret');

    const refusedWrite = await outcome(renamePage({ currentTitle: 'Roadmap', pageId: nw.orgPage.id, title: 'Pwned' }, toolOptions(magicLink)));
    expect(refusedWrite).toMatch(/^refused: .*permission/i);
    const [row] = await db.select({ title: pages.title }).from(pages).where(eq(pages.id, nw.orgPage.id));
    expect(row.title).toBe('Roadmap');
  });

  it('SEC-3 (partial) the resolvers behind realtime joins and document_update refuse a stale credential the org page and drive', async () => {
    const nw = await northwind({ maximumSessionAgeMinutes: 15 });
    const stale = await actorOf(await mintSession(nw.person.id, evidence('user_verified_passkey', HOUR)));
    const fresh = await actorOf(await mintSession(nw.person.id, evidence('user_verified_passkey')));

    // join_drive asks getUserDriveAccess; join_channel, presence and document_update ask getUserAccessLevel.
    expect(await getUserDriveAccess(stale, nw.orgDrive.id)).toBe(false);
    expect(await getUserAccessLevel(stale, nw.orgPage.id)).toBeNull();
    expect(await getUserDriveAccess(stale, nw.personalDrive.id)).toBe(true);
    expect((await getUserAccessLevel(stale, nw.personalPage.id))?.canEdit).toBe(true);
    expect((await getUserAccessLevel(fresh, nw.orgPage.id))?.canEdit).toBe(true);
  });

  it('SEC-2 (partial) a processor service token is minted only for a credential the org admits, and carries that credential\'s evidence', async () => {
    const nw = await northwind({ requireStrongSignIn: true });
    const magicLink = credentialActor(nw.person.id, evidence('single_factor'));
    const passkeyEvidence = evidence('user_verified_passkey');

    await expect(createPageServiceToken(magicLink, nw.orgPage.id, ['files:read'])).rejects.toThrow();
    const { token } = await createPageServiceToken(credentialActor(nw.person.id, passkeyEvidence), nw.orgPage.id, ['files:read']);
    const claims = await sessionService.validateSession(token);
    expect(claims?.authentication).toEqual(passkeyEvidence);
    // The processor rebuilds the actor from these claims and asks the same seam.
    expect(await getUserAccessLevel(EnforcedAuthContext.fromSession(claims!).actor, nw.orgPage.id)).not.toBeNull();
  });
});
