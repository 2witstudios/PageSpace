// @vitest-environment node
/**
 * SEC-2/3 against PostgreSQL for content DERIVED from several orgs' drives and stored for one person (D-OW-62): the
 * Pulse summary and distilled memory. Each records the orgs whose drives fed it; it is served only to a credential
 * every one of those orgs' sign-in policy admits, and otherwise withheld with the code that unlocks it. Content no org
 * fed is always served.
 *
 * Real sessions, authenticated by the production request path from the token string alone.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { users } from '@pagespace/db/schema/auth';
import { pulseSummaries } from '@pagespace/db/schema/dashboard';
import { userPersonalization } from '@pagespace/db/schema/personalization';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';
import { pagePermissions } from '@pagespace/db/schema/members';
import { factories } from '@pagespace/db/test/factories';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { credentialActor } from '@pagespace/lib/permissions/access-actor';
import { orgIdsOfSources } from '@pagespace/lib/permissions/org-derived-content';
import type { OrgPolicies } from '@pagespace/lib/organizations/policies-core';
import type { VerifiedAuthentication } from '@pagespace/lib/auth/authentication-evidence';

import { provisionMemoryPages } from '@pagespace/lib/memory/memory-pages';
import { getResourceAuthenticationPolicies } from '@pagespace/lib/organizations/policy-reader';
import { accessiblePageIds } from '@pagespace/lib/permissions/accessible-page-ids';
import {
  canUserViewPage,
  getBatchPagePermissions,
  getUserAccessiblePagesInDrive,
  getUserAccessiblePagesInDriveWithDetails,
} from '@pagespace/lib/permissions/permissions';

import { GET as getPulse } from '@/app/api/pulse/route';
import { GET as getPage } from '@/app/api/pages/[pageId]/route';
import { GET as getPersonalizationSettings } from '@/app/api/settings/personalization/route';
import { getUserPersonalization } from '@/lib/ai/core/personalization-utils';
import { recordMemoryOrgIds } from '@/lib/memory/candidate-service';

const MINUTE = 60_000;
const created = { users: [] as string[], orgs: [] as string[] };

const evidence = (assurance: VerifiedAuthentication['assurance'], ageMinutes = 0): VerifiedAuthentication =>
  ({ authenticatedAtMs: Date.now() - ageMinutes * MINUTE, assurance });
const bearer = (token: string): HeadersInit => ({ authorization: `Bearer ${token}` });

const session = (userId: string, assurance: VerifiedAuthentication['assurance'], ageMinutes = 0) =>
  sessionService.createSession({
    userId, type: 'user', scopes: ['*'], expiresInMs: 24 * 60 * MINUTE, authentication: evidence(assurance, ageMinutes),
  });

async function person() {
  const user = await factories.createUser();
  created.users.push(user.id);
  return user;
}

/** An org the person owns, with the given sign-in policy and one drive. */
async function orgWithDrive(ownerId: string, policies: Partial<OrgPolicies>) {
  const [org] = await db.insert(organizations).values({
    name: 'Northwind', slug: `nw-${createId()}`, ownerId, policies,
  }).returning();
  created.orgs.push(org.id);
  await db.insert(orgMembers).values({ orgId: org.id, userId: ownerId, role: 'OWNER' });
  const orgDrive = await factories.createDrive(ownerId, { orgId: org.id, orgVisibility: 'OPEN' });
  return { org, orgDrive };
}

async function storeSummary(userId: string, orgIds: string[]) {
  const now = new Date();
  await db.insert(pulseSummaries).values({
    userId,
    summary: 'Northwind board prep moved to Friday.',
    greeting: 'Good morning',
    type: 'scheduled',
    orgIds,
    periodStart: new Date(now.getTime() - 6 * 60 * MINUTE),
    periodEnd: now,
    generatedAt: now,
    expiresAt: new Date(now.getTime() + 6 * 60 * MINUTE),
  });
}

type PulseBody = {
  summary: { text: string } | null;
  signInRequired: { code: string; orgIds: string[] } | null;
  stats: unknown;
};

async function readPulse(token: string): Promise<PulseBody> {
  const res = await getPulse(new Request('https://app.test/api/pulse', { headers: bearer(token) }));
  expect(res.status).toBe(200);
  return await res.json() as PulseBody;
}

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for this integration suite');
});

afterEach(async () => {
  if (created.orgs.length) await db.delete(drives).where(inArray(drives.orgId, created.orgs));
  if (created.orgs.length) await db.delete(organizations).where(inArray(organizations.id, created.orgs.splice(0)));
  if (created.users.length) await db.delete(users).where(inArray(users.id, created.users.splice(0)));
});

describe('Pulse summaries', () => {
  it('SEC-2 (partial) a summary an org-drive fed under requireStrongSignIn is withheld from a single-factor session with the code and the org, while the stats stand; a passkey session reads it', async () => {
    const user = await person();
    const { org } = await orgWithDrive(user.id, { requireStrongSignIn: true });
    await storeSummary(user.id, [org.id]);

    const weak = await readPulse(await session(user.id, 'single_factor'));
    expect(weak.summary).toBeNull();
    expect(weak.signInRequired).toEqual({ code: 'org_strong_sign_in_required', orgIds: [org.id] });
    expect(weak.stats).toBeDefined();

    const strong = await readPulse(await session(user.id, 'user_verified_passkey'));
    expect(strong.summary?.text).toBe('Northwind board prep moved to Friday.');
    expect(strong.signInRequired).toBeNull();
  });

  it('SEC-3 (partial) a summary an org fed under a maximum session age is withheld from a session older than it allows with the sign-in-again code; a fresh session reads it', async () => {
    const user = await person();
    const { org } = await orgWithDrive(user.id, { maximumSessionAgeMinutes: 30 });
    await storeSummary(user.id, [org.id]);

    const stale = await readPulse(await session(user.id, 'single_factor', 120));
    expect(stale.summary).toBeNull();
    expect(stale.signInRequired).toEqual({ code: 'org_reauthentication_required', orgIds: [org.id] });

    const fresh = await readPulse(await session(user.id, 'single_factor'));
    expect(fresh.summary?.text).toBe('Northwind board prep moved to Friday.');
  });

  it('SEC-2 (partial) a summary only personal drives fed is always returned, whatever the sign-in', async () => {
    const user = await person();
    // The person still belongs to a passkey-only org: what matters is which orgs fed THIS summary.
    await orgWithDrive(user.id, { requireStrongSignIn: true });
    await storeSummary(user.id, []);

    const weak = await readPulse(await session(user.id, 'single_factor'));
    expect(weak.summary?.text).toBe('Northwind board prep moved to Friday.');
    expect(weak.signInRequired).toBeNull();
  });

  it('SEC-2 (partial) the writers record as contributing every org whose drive or page-granted page can feed the summary, and no org for personal drives', async () => {
    const user = await person();
    const { org: memberOrg, orgDrive } = await orgWithDrive(user.id, { requireStrongSignIn: true });
    const personalDrive = await factories.createDrive(user.id);

    // A page in another org's drive the person reaches only through a page-level grant.
    const other = await person();
    const { org: grantOrg, orgDrive: grantDrive } = await orgWithDrive(other.id, {});
    const grantedPage = await factories.createPage(grantDrive.id, { title: 'Shared plan' });
    await db.insert(pagePermissions).values({
      pageId: grantedPage.id, userId: user.id, canView: true, canEdit: false, canShare: false, canDelete: false,
    });

    const orgIds = await orgIdsOfSources({ driveIds: [orgDrive.id, personalDrive.id], pageIds: [grantedPage.id] });
    expect(orgIds).toEqual([memberOrg.id, grantOrg.id].sort());
    expect(await orgIdsOfSources({ driveIds: [personalDrive.id], pageIds: [] })).toEqual([]);
  });
});

describe('distilled memory', () => {
  /** Memory with legacy content and no page pointers, recorded against `orgIds` by the memory cron's recorder. */
  async function memoryFrom(userId: string, orgIds: string[]) {
    await db.insert(userPersonalization).values({ userId, enabled: true, rules: 'Lead with the Northwind roadmap.' });
    await recordMemoryOrgIds(userId, orgIds);
  }

  it('SEC-2 (partial) memory distilled from a requireStrongSignIn org is not injected for a single-factor credential, and the settings API withholds its previews with the code; a passkey credential gets it', async () => {
    const user = await person();
    const { org } = await orgWithDrive(user.id, { requireStrongSignIn: true });
    await memoryFrom(user.id, [org.id]);

    expect(await getUserPersonalization(credentialActor(user.id, evidence('single_factor')))).toBeNull();
    expect((await getUserPersonalization(credentialActor(user.id, evidence('user_verified_passkey'))))?.rules)
      .toBe('Lead with the Northwind roadmap.');

    const settings = async (token: string) => {
      const res = await getPersonalizationSettings(new Request('https://app.test/api/settings/personalization', { headers: bearer(token) }));
      expect(res.status).toBe(200);
      return await res.json() as { signInRequired: { code: string; orgIds: string[] } | null };
    };
    expect((await settings(await session(user.id, 'single_factor'))).signInRequired)
      .toEqual({ code: 'org_strong_sign_in_required', orgIds: [org.id] });
    expect((await settings(await session(user.id, 'user_verified_passkey'))).signInRequired).toBeNull();
  });

  it('SEC-2 (partial) memory no org contributed to is injected for any credential', async () => {
    const user = await person();
    await orgWithDrive(user.id, { requireStrongSignIn: true });
    await memoryFrom(user.id, []);

    expect((await getUserPersonalization(credentialActor(user.id, evidence('single_factor'))))?.rules)
      .toBe('Lead with the Northwind roadmap.');
  });

  it('SEC-2 (partial) the memory\'s orgs only ever grow: recording more orgs unions them, sorted and distinct', async () => {
    const user = await person();
    const a = await orgWithDrive(user.id, {});
    const b = await orgWithDrive(user.id, {});
    await memoryFrom(user.id, [b.org.id]);
    await recordMemoryOrgIds(user.id, [a.org.id, b.org.id]);

    const [row] = await db.select({ memoryOrgIds: userPersonalization.memoryOrgIds })
      .from(userPersonalization).where(eq(userPersonalization.userId, user.id));
    expect(row.memoryOrgIds).toEqual([a.org.id, b.org.id].sort());
  });
});

describe('memory pages (the pages the distilled memory lives in)', () => {
  /** The person's memory pages in a drive of their own, the memory recorded against `orgIds`, and an ordinary page. */
  async function memoryPagesFrom(userId: string, orgIds: string[]) {
    const homeDrive = await factories.createDrive(userId);
    const memory = await db.transaction((tx) => provisionMemoryPages(userId, homeDrive.id, tx));
    await recordMemoryOrgIds(userId, orgIds);
    const notes = await factories.createPage(homeDrive.id, { title: 'Grocery list' });
    return { homeDrive, memory, notes };
  }

  const readPage = (token: string, pageId: string) =>
    getPage(new Request(`https://app.test/api/pages/${pageId}`, { headers: bearer(token) }), { params: Promise.resolve({ pageId }) });

  it('SEC-2 (partial) a memory page restating a requireStrongSignIn org is withheld from a single-factor credential on every read path, with the code; the person\'s other pages stand; a passkey credential reads it', async () => {
    const user = await person();
    const { org } = await orgWithDrive(user.id, { requireStrongSignIn: true });
    const { homeDrive, memory, notes } = await memoryPagesFrom(user.id, [org.id]);
    const weak = credentialActor(user.id, evidence('single_factor'));
    const strong = credentialActor(user.id, evidence('user_verified_passkey'));

    // The page route answers the code that unlocks it, not a bare 403.
    const refused = await readPage(await session(user.id, 'single_factor'), memory.rulesPageId);
    expect(refused.status).toBe(403);
    expect((await refused.json() as { code: string }).code).toBe('org_strong_sign_in_required');
    expect((await readPage(await session(user.id, 'single_factor'), notes.id)).status).toBe(200);
    expect((await readPage(await session(user.id, 'user_verified_passkey'), memory.rulesPageId)).status).toBe(200);

    // Every listing and check the page, search, tool, export and realtime paths are built on.
    expect(await canUserViewPage(weak, memory.bioPageId)).toBe(false);
    expect(await canUserViewPage(strong, memory.bioPageId)).toBe(true);
    const memoryIds = [memory.bioPageId, memory.writingStylePageId, memory.rulesPageId];
    const batch = await getBatchPagePermissions(weak, [...memoryIds, notes.id]);
    expect(memoryIds.map((id) => batch.get(id)?.canView)).toEqual([false, false, false]);
    expect(batch.get(notes.id)?.canView).toBe(true);
    for (const listed of [
      await accessiblePageIds(weak),
      await getUserAccessiblePagesInDrive(weak, homeDrive.id),
      (await getUserAccessiblePagesInDriveWithDetails(weak, homeDrive.id)).map((page) => page.id),
    ]) {
      expect(listed).toContain(notes.id);
      expect(listed.filter((id) => memoryIds.includes(id))).toEqual([]);
    }
    expect(await getUserAccessiblePagesInDrive(strong, homeDrive.id)).toEqual(expect.arrayContaining(memoryIds));
  });

  it('SEC-3 (partial) a live socket holding a memory page re-decides it against every contributing org\'s policy, folded into the strictest', async () => {
    const user = await person();
    const strongOrg = await orgWithDrive(user.id, { requireStrongSignIn: true });
    const agedOrg = await orgWithDrive(user.id, { maximumSessionAgeMinutes: 30 });
    const { memory, notes } = await memoryPagesFrom(user.id, [strongOrg.org.id, agedOrg.org.id]);

    const policies = await getResourceAuthenticationPolicies([memory.bioPageId, notes.id, agedOrg.orgDrive.id]);
    expect(policies.get(memory.bioPageId)).toEqual({ requireStrongSignIn: true, maximumSessionAgeMinutes: 30 });
    expect(policies.get(notes.id)).toBeNull();
    expect(policies.get(agedOrg.orgDrive.id)).toEqual({ requireStrongSignIn: false, maximumSessionAgeMinutes: 30 });
  });

  it('SEC-2 (partial) memory pages no org contributed to are read by any credential', async () => {
    const user = await person();
    await orgWithDrive(user.id, { requireStrongSignIn: true });
    const { memory } = await memoryPagesFrom(user.id, []);

    expect(await canUserViewPage(credentialActor(user.id, evidence('single_factor')), memory.rulesPageId)).toBe(true);
  });
});
