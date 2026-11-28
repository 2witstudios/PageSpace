// @vitest-environment node
/**
 * SEC-2/3 for drive backups against PostgreSQL (D-OW-62): a memory page restates distilled memory, so it carries the
 * orgs that memory came from. A backup snapshot, its zip export and its previews are reads of every page in the drive:
 * a memory page a contributing org's sign-in policy withholds from the credential is left out of each, and the backup
 * or export names what it left out with the code that unlocks it. A restore leaves pages a snapshot withheld alone.
 *
 * Only blob storage is faked (createPageVersion stores content under an in-memory ref that readPageContent reads back);
 * every row, permission decision and sign-in policy read is real.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { drives, pages } from '@pagespace/db/schema/core';
import { users } from '@pagespace/db/schema/auth';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';
import { driveBackupPages, driveBackups } from '@pagespace/db/schema/versioning';
import { factories } from '@pagespace/db/test/factories';
import type { OrgPolicies } from '@pagespace/lib/organizations/policies-core';
import type { VerifiedAuthentication } from '@pagespace/lib/auth/authentication-evidence';

const blobs = vi.hoisted(() => new Map<string, string>());

vi.mock('@pagespace/lib/services/page-version-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/services/page-version-service')>()),
  createPageVersion: vi.fn(async (
    input: { pageId: string; driveId: string; createdBy?: string | null; source: string; content: string; contentFormat?: string; pageRevision: number; stateHash?: string | null; changeGroupId?: string | null; changeGroupType?: string | null; metadata?: Record<string, unknown> },
    options?: { tx?: unknown },
  ) => {
    const { pageVersions } = await import('@pagespace/db/schema/versioning');
    const database = (options?.tx ?? (await import('@pagespace/db/db')).db) as { insert: (t: unknown) => { values: (v: unknown) => { returning: (s: unknown) => Promise<{ id: string }[]> } } };
    const ref = `test:${input.pageId}:${blobs.size}`;
    blobs.set(ref, input.content);
    const [created] = await database.insert(pageVersions).values({
      pageId: input.pageId,
      driveId: input.driveId,
      createdBy: input.createdBy ?? null,
      source: input.source,
      changeGroupId: input.changeGroupId,
      changeGroupType: input.changeGroupType,
      contentRef: ref,
      contentFormat: input.contentFormat ?? 'markdown',
      contentSize: input.content.length,
      stateHash: input.stateHash,
      pageRevision: input.pageRevision,
      metadata: input.metadata,
    }).returning({ id: pageVersions.id });
    return { id: created.id, contentRef: ref, contentSize: input.content.length, compressed: false, storedSize: input.content.length, compressionRatio: 1 };
  }),
}));

vi.mock('@pagespace/lib/services/page-content-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/services/page-content-store')>()),
  readPageContent: vi.fn(async (ref: string) => {
    const content = blobs.get(ref);
    if (content === undefined) throw new Error(`no blob ${ref}`);
    return content;
  }),
}));

import { sessionService } from '@pagespace/lib/auth/session-service';
import { credentialActor } from '@pagespace/lib/permissions/access-actor';
import { provisionMemoryPages } from '@pagespace/lib/memory/memory-pages';
import { recordMemoryOrgIds } from '@/lib/memory/candidate-service';
import { createDriveBackup } from '../drive-backup-service';
import { streamBackupExport, type ExportManifest } from '../backup-export-service';
import { fetchAndComputeRestoreDiff } from '../restore-diff-service';
import { GET as getDriveBackupPages } from '@/app/api/drives/[driveId]/backups/[backupId]/pages/route';
import { GET as getBackupPages } from '@/app/api/backups/[backupId]/pages/route';

const MINUTE = 60_000;
const created = { users: [] as string[], orgs: [] as string[] };

const evidence = (assurance: VerifiedAuthentication['assurance']): VerifiedAuthentication =>
  ({ authenticatedAtMs: Date.now() - MINUTE, assurance });
const session = (userId: string, assurance: VerifiedAuthentication['assurance']) =>
  sessionService.createSession({ userId, type: 'user', scopes: ['*'], expiresInMs: 24 * 60 * MINUTE, authentication: evidence(assurance) });

/** A person whose memory was distilled from a passkey-only org, with memory pages and an ordinary page in their own drive. */
async function personWithOrgMemory() {
  const user = await factories.createUser();
  created.users.push(user.id);
  const policies: Partial<OrgPolicies> = { requireStrongSignIn: true };
  const [org] = await db.insert(organizations).values({ name: 'Northwind', slug: `nw-${createId()}`, ownerId: user.id, policies }).returning();
  created.orgs.push(org.id);
  await db.insert(orgMembers).values({ orgId: org.id, userId: user.id, role: 'OWNER' });
  await factories.createDrive(user.id, { orgId: org.id, orgVisibility: 'OPEN' });

  const homeDrive = await factories.createDrive(user.id);
  const memory = await db.transaction((tx) => provisionMemoryPages(user.id, homeDrive.id, tx));
  await recordMemoryOrgIds(user.id, [org.id]);
  const memoryIds = [memory.bioPageId, memory.writingStylePageId, memory.rulesPageId];
  for (const id of memoryIds) {
    await db.update(pages).set({ content: `MEMORY-SECRET-${id}` }).where(eq(pages.id, id));
  }
  const notes = await factories.createPage(homeDrive.id, { title: 'Grocery list', content: 'NOTES-VISIBLE' });
  return { user, org, homeDrive, memoryIds, notes };
}

const weak = (userId: string) => credentialActor(userId, evidence('single_factor'));
const strong = (userId: string) => credentialActor(userId, evidence('user_verified_passkey'));

/** The entries of a STORED (uncompressed) zip, by name, read through its central directory. */
function unzipStored(zip: Buffer): Map<string, string> {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const entryCount = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  const out = new Map<string, string>();
  for (let i = 0; i < entryCount; i++) {
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const localOffset = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf-8');
    const dataStart = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
    out.set(name, zip.subarray(dataStart, dataStart + size).toString('utf-8'));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

async function exportZip(backupId: string, driveId: string, actor: ReturnType<typeof weak>) {
  const chunks: Buffer[] = [];
  for await (const chunk of await streamBackupExport(backupId, driveId, actor)) chunks.push(chunk);
  const entries = unzipStored(Buffer.concat(chunks));
  const manifest = JSON.parse(entries.get('manifest.json') ?? '{}') as ExportManifest;
  return { entries, manifest };
}

async function backupOf(driveId: string, actor: ReturnType<typeof weak>) {
  const result = await createDriveBackup(driveId, actor, { source: 'manual' });
  expect(result.success).toBe(true);
  return result.backupId as string;
}

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for this integration suite');
});

afterEach(async () => {
  if (created.orgs.length) await db.delete(drives).where(inArray(drives.orgId, created.orgs));
  if (created.orgs.length) await db.delete(organizations).where(inArray(organizations.id, created.orgs.splice(0)));
  if (created.users.length) {
    await db.delete(drives).where(inArray(drives.ownerId, created.users));
    await db.delete(users).where(inArray(users.id, created.users.splice(0)));
  }
});

describe('drive backups and org-derived memory pages', () => {
  it('SEC-2 (partial) a single-factor backup of the Home drive leaves out the memory pages a passkey-only org withholds, and records them with the code', async () => {
    const { user, org, homeDrive, memoryIds, notes } = await personWithOrgMemory();
    const backupId = await backupOf(homeDrive.id, weak(user.id));

    const snapshotted = (await db.select({ pageId: driveBackupPages.pageId }).from(driveBackupPages).where(eq(driveBackupPages.backupId, backupId))).map((r) => r.pageId);
    expect(snapshotted).toContain(notes.id);
    expect(snapshotted.filter((id) => memoryIds.includes(id))).toEqual([]);

    const [row] = await db.select({ metadata: driveBackups.metadata }).from(driveBackups).where(eq(driveBackups.id, backupId));
    expect(row.metadata?.signInWithheld).toEqual({
      pageIds: [...memoryIds].sort(),
      entries: [{ category: 'memoryPages', count: 3, code: 'org_strong_sign_in_required', orgIds: [org.id] }],
    });

    // Its export says so too, and carries the ordinary page.
    const { entries, manifest } = await exportZip(backupId, homeDrive.id, weak(user.id));
    expect(entries.get(`${notes.id}.txt`)).toBe('NOTES-VISIBLE');
    expect([...entries.values()].some((content) => content.includes('MEMORY-SECRET'))).toBe(false);
    expect(manifest.withheld).toEqual([{ category: 'memoryPages', count: 3, code: 'org_strong_sign_in_required', orgIds: [org.id] }]);
  });

  it('SEC-2 (partial) a passkey backup carries the memory pages, and only a passkey export streams them: a single-factor export of the same backup withholds them', async () => {
    const { user, org, homeDrive, memoryIds, notes } = await personWithOrgMemory();
    const backupId = await backupOf(homeDrive.id, strong(user.id));

    const full = await exportZip(backupId, homeDrive.id, strong(user.id));
    for (const id of memoryIds) expect(full.entries.get(`${id}.txt`)).toBe(`MEMORY-SECRET-${id}`);
    expect(full.manifest.withheld).toEqual([]);

    const gated = await exportZip(backupId, homeDrive.id, weak(user.id));
    expect(gated.entries.get(`${notes.id}.txt`)).toBe('NOTES-VISIBLE');
    expect([...gated.entries.values()].some((content) => content.includes('MEMORY-SECRET'))).toBe(false);
    expect(gated.manifest.pages.map((p) => p.pageId).filter((id) => memoryIds.includes(id))).toEqual([]);
    expect(gated.manifest.withheld).toEqual([{ category: 'memoryPages', count: 3, code: 'org_strong_sign_in_required', orgIds: [org.id] }]);
  });

  it('SEC-2 (partial) the backup previews withhold memory page content from a single-factor session, with the code', async () => {
    const { user, org, homeDrive, memoryIds, notes } = await personWithOrgMemory();
    const backupId = await backupOf(homeDrive.id, strong(user.id));
    const token = await session(user.id, 'single_factor');
    const headers = { authorization: `Bearer ${token}` };

    type Preview = { pages: Array<{ pageId: string; content?: string; children?: Preview['pages'] }>; withheld: unknown };
    const flatten = (nodes: Preview['pages']): Preview['pages'] => nodes.flatMap((n) => [n, ...flatten(n.children ?? [])]);
    for (const res of [
      await getDriveBackupPages(new Request(`https://app.test/api/drives/${homeDrive.id}/backups/${backupId}/pages?includeContent=true`, { headers }), { params: Promise.resolve({ driveId: homeDrive.id, backupId }) }),
      await getBackupPages(new Request(`https://app.test/api/backups/${backupId}/pages?includeContent=true`, { headers }), { params: Promise.resolve({ backupId }) }),
    ]) {
      expect(res.status).toBe(200);
      const body = await res.json() as Preview;
      const listed = flatten(body.pages);
      expect(listed.find((p) => p.pageId === notes.id)?.content).toBe('NOTES-VISIBLE');
      expect(listed.filter((p) => memoryIds.includes(p.pageId))).toEqual([]);
      expect(JSON.stringify(body)).not.toContain('MEMORY-SECRET');
      expect(body.withheld).toEqual([{ category: 'memoryPages', count: 3, code: 'org_strong_sign_in_required', orgIds: [org.id] }]);
    }
  });

  it('SEC-2 (partial) restoring a backup that withheld the memory pages leaves them alone: neither trashed nor overwritten', async () => {
    const { user, homeDrive, memoryIds } = await personWithOrgMemory();
    const backupId = await backupOf(homeDrive.id, weak(user.id));

    const result = await fetchAndComputeRestoreDiff(backupId, homeDrive.id, db);
    if (!result.ok) throw new Error('diff not computed');
    const touched = [...result.diff.toOrphan, ...result.diff.toOverwrite, ...result.diff.toCreate].map((p) => p.pageId);
    expect(touched.filter((id) => memoryIds.includes(id))).toEqual([]);
  });
});
