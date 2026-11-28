/**
 * SEC-2/3 for the Art 15 export against PostgreSQL (D-OW-62): requested through the subject's own credential, the bundle
 * carries org content (including what the subject wrote, uploaded or did there) and digests derived from it only when every contributing org's sign-in policy admits that
 * credential. What it leaves out is recorded in the manifest with the code that unlocks it; content no org fed is always
 * carried, and the operator's bundle (admin console) is complete.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { inArray } from 'drizzle-orm';
import { db } from '@pagespace/db/db';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';
import { pulseSummaries } from '@pagespace/db/schema/dashboard';
import { personalizationCandidates, userPersonalization } from '@pagespace/db/schema/personalization';
import { channelMessages } from '@pagespace/db/schema/chat';
import { files } from '@pagespace/db/schema/storage';
import { taskLists } from '@pagespace/db/schema/tasks';
import { activityLogs } from '@pagespace/db/schema/monitoring';
import { factories } from '@pagespace/db/test/factories';
import { credentialActor } from '../../../permissions/access-actor';
import type { VerifiedAuthentication } from '../../../auth/authentication-evidence';
import type { OrgPolicies } from '../../../organizations/policies-core';
import { collectAllUserData, type AllUserData } from '../gdpr-export';
import { buildExportManifest, buildNativeExportFiles } from '../export-format';
import { credentialExportGate, OPERATOR_EXPORT_GATE } from '../export-sign-in-gate';

const MINUTE = 60_000;
const created = { users: [] as string[], orgs: [] as string[] };

const evidence = (assurance: VerifiedAuthentication['assurance']): VerifiedAuthentication =>
  ({ authenticatedAtMs: Date.now() - MINUTE, assurance });

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for this integration suite');
});

afterEach(async () => {
  if (created.users.length) await db.delete(activityLogs).where(inArray(activityLogs.userId, created.users));
  if (created.orgs.length) await db.delete(drives).where(inArray(drives.orgId, created.orgs));
  if (created.orgs.length) await db.delete(organizations).where(inArray(organizations.id, created.orgs.splice(0)));
  if (created.users.length) await db.delete(users).where(inArray(users.id, created.users.splice(0)));
});

/**
 * A person with a Home drive (holding their memory pages) and an org drive in an org that requires `policies`. Their
 * memory, one Pulse summary and one inference drew on the org drive; one summary and one inference drew on nothing. In
 * each drive they wrote a channel message, uploaded a file, kept a task list and have an activity entry.
 */
async function subject(policies: Partial<OrgPolicies>) {
  const user = await factories.createUser();
  created.users.push(user.id);
  const [org] = await db.insert(organizations).values({ name: 'Northwind', slug: `nw-${createId()}`, ownerId: user.id, policies }).returning();
  created.orgs.push(org.id);
  await db.insert(orgMembers).values({ orgId: org.id, userId: user.id, role: 'OWNER' });

  const home = await factories.createDrive(user.id);
  const orgDrive = await factories.createDrive(user.id, { orgId: org.id, orgVisibility: 'OPEN' });
  const personalPage = await factories.createPage(home.id, { title: 'Grocery list', content: 'eggs' });
  const orgPage = await factories.createPage(orgDrive.id, { title: 'Board prep', content: 'Northwind board prep' });
  const bio = await factories.createPage(home.id, { title: 'About You', content: 'Leads Northwind board prep' });
  const style = await factories.createPage(home.id, { title: 'Communication', content: 'Brief' });
  const rules = await factories.createPage(home.id, { title: 'Rules', content: 'No emojis' });
  await db.insert(userPersonalization).values({
    userId: user.id, bioPageId: bio.id, writingStylePageId: style.id, rulesPageId: rules.id, memoryOrgIds: [org.id],
  });

  const now = new Date();
  const summary = (text: string, orgIds: string[]) => ({
    userId: user.id, summary: text, type: 'scheduled' as const, orgIds,
    periodStart: new Date(now.getTime() - 60 * MINUTE), periodEnd: now, generatedAt: now, expiresAt: new Date(now.getTime() + 60 * MINUTE),
  });
  await db.insert(pulseSummaries).values([summary('Northwind board prep moved', [org.id]), summary('Quiet day', [])]);
  const candidate = (claim: string, orgIds: string[]) => ({
    userId: user.id, field: 'bio', claim, claimKey: claim.toLowerCase(), evidence: 'quote', orgIds,
  });
  await db.insert(personalizationCandidates).values([candidate('Leads Northwind board prep', [org.id]), candidate('Likes eggs', [])]);

  for (const [drive, page, label] of [[home, personalPage, 'Personal'], [orgDrive, orgPage, 'Northwind']] as const) {
    await db.insert(channelMessages).values({ pageId: page.id, userId: user.id, content: `${label} message` });
    await db.insert(files).values({ id: `${label}-${createId()}`, driveId: drive.id, sizeBytes: 1, createdBy: user.id });
    await db.insert(taskLists).values({ userId: user.id, pageId: page.id, title: `${label} tasks` });
    await db.insert(activityLogs).values({
      userId: user.id, operation: 'update', resourceType: 'page', resourceId: page.id, resourceTitle: `${label} edit`, driveId: drive.id, pageId: page.id,
    });
  }

  return { user, org, orgDrive, personalPage, orgPage, memoryPageIds: [bio.id, style.id, rules.id] };
}

const pageIds = (data: AllUserData) => data.pages.map((p) => p.id);

describe('the Art 15 export under an org sign-in policy', () => {
  it('SEC-2 (partial) a single-factor session exports no content of a passkey-only org nor anything derived from it, and the manifest names each omission with its code; personal content is all there', async () => {
    const s = await subject({ requireStrongSignIn: true });
    const data = await collectAllUserData(db, s.user.id, credentialExportGate(credentialActor(s.user.id, evidence('single_factor'))));
    if (!data) throw new Error('subject not found');

    expect(pageIds(data)).toContain(s.personalPage.id);
    expect(pageIds(data)).not.toContain(s.orgPage.id);
    for (const id of s.memoryPageIds) expect(pageIds(data)).not.toContain(id);
    expect(data.drives.map((d) => d.id)).toContain(s.orgDrive.id);
    expect(data.pulseSummaries.map((p) => p.summary)).toEqual(['Quiet day']);
    expect(data.personalizationCandidates.map((c) => c.claim)).toEqual(['Likes eggs']);
    expect(data.personalization).toMatchObject({ bio: null, writingStyle: null, rules: null, enabled: true });
    expect(data.messages.map((m) => m.content)).toEqual(['Personal message']);
    expect(data.files.map((f) => f.id.split('-')[0])).toEqual(['Personal']);
    expect(data.tasks.map((t) => t.listTitle)).toEqual(['Personal tasks']);
    expect(data.activity.map((a) => a.resourceId)).toEqual([s.personalPage.id]);
    expect(JSON.stringify(data)).not.toContain('Northwind board prep');
    expect(JSON.stringify(data)).not.toContain('Northwind message');

    const code = 'org_strong_sign_in_required';
    const manifest = buildExportManifest(buildNativeExportFiles(data), { exportedAt: new Date(), format: 'native', withheld: data.withheld });
    expect(manifest.withheld).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'orgDriveContent', count: 1, code, orgIds: [s.org.id] }),
      expect.objectContaining({ category: 'memoryPages', count: 3, code, orgIds: [s.org.id] }),
      expect.objectContaining({ category: 'pulseSummaries', count: 1, code, orgIds: [s.org.id] }),
      expect.objectContaining({ category: 'personalizationCandidates', count: 1, code, orgIds: [s.org.id] }),
      expect.objectContaining({ category: 'personalization', count: 1, code, orgIds: [s.org.id] }),
      expect.objectContaining({ category: 'orgDriveMessages', count: 1, code, orgIds: [s.org.id] }),
      expect.objectContaining({ category: 'orgDriveFiles', count: 1, code, orgIds: [s.org.id] }),
      expect.objectContaining({ category: 'orgDriveTasks', count: 1, code, orgIds: [s.org.id] }),
      expect.objectContaining({ category: 'orgDriveActivity', count: 1, code, orgIds: [s.org.id] }),
    ]));
    expect(manifest.withheld).toHaveLength(9);
    for (const entry of manifest.withheld) expect(entry.note).toContain('passkey');
  });

  it('SEC-2 (partial) a passkey session exports everything, and the manifest withholds nothing', async () => {
    const s = await subject({ requireStrongSignIn: true });
    const data = await collectAllUserData(db, s.user.id, credentialExportGate(credentialActor(s.user.id, evidence('user_verified_passkey'))));
    if (!data) throw new Error('subject not found');

    expect(pageIds(data)).toEqual(expect.arrayContaining([s.personalPage.id, s.orgPage.id, ...s.memoryPageIds]));
    expect(data.pulseSummaries).toHaveLength(2);
    expect(data.personalizationCandidates).toHaveLength(2);
    expect(data.personalization?.bio).toBe('Leads Northwind board prep');
    expect(data.messages.map((m) => m.content).sort()).toEqual(['Northwind message', 'Personal message']);
    expect(data.files).toHaveLength(2);
    expect(data.tasks.map((t) => t.listTitle).sort()).toEqual(['Northwind tasks', 'Personal tasks']);
    expect(data.activity).toHaveLength(2);
    expect(data.withheld).toEqual([]);
    expect(JSON.stringify(data.pulseSummaries)).not.toContain('orgIds');
    expect(Object.keys(data.tasks[0])).not.toContain('pageId');
    expect(Object.keys(data.activity[0])).not.toContain('driveId');
  });

  it('SEC-3 (partial) a session past the org maximum age is told to sign in again, not to use a passkey', async () => {
    const s = await subject({ maximumSessionAgeMinutes: 15 });
    const stale = credentialActor(s.user.id, { authenticatedAtMs: Date.now() - 60 * MINUTE, assurance: 'user_verified_passkey' });
    const data = await collectAllUserData(db, s.user.id, credentialExportGate(stale));
    if (!data) throw new Error('subject not found');

    expect(data.withheld.map((w) => w.code)).toEqual(Array(9).fill('org_reauthentication_required'));
    expect(data.pulseSummaries.map((p) => p.summary)).toEqual(['Quiet day']);
  });

  it('the operator fulfilling the request on the subject behalf exports everything', async () => {
    const s = await subject({ requireStrongSignIn: true });
    const data = await collectAllUserData(db, s.user.id, OPERATOR_EXPORT_GATE);
    if (!data) throw new Error('subject not found');

    expect(pageIds(data)).toEqual(expect.arrayContaining([s.orgPage.id, ...s.memoryPageIds]));
    expect(data.pulseSummaries).toHaveLength(2);
    expect(data.messages).toHaveLength(2);
    expect(data.files).toHaveLength(2);
    expect(data.withheld).toEqual([]);
  });
});
