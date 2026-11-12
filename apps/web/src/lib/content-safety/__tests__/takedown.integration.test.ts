/**
 * Content takedown, end to end — REAL Postgres, with the S3 clients faked at
 * the SDK boundary (one in-memory store standing in for the uploads, publish
 * and evidence buckets).
 *
 *   1. upload a file and publish it
 *   2. run a global takedown
 *   3. the public asset is deleted and the evidence copy exists
 *   4. the view route answers 410
 *   5. a re-upload of the same bytes is refused by PR 1's gate
 *
 * The file is a harmless test string. Nothing here is, or needs to be, real
 * illegal content.
 *
 * Requires DATABASE_URL → a migrated test Postgres; fails loudly without one.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHash, randomUUID } from 'crypto';

const fakeS3 = vi.hoisted(() => ({ current: null as null | { send(command: unknown): Promise<unknown> } }));
vi.mock('@aws-sdk/client-s3', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aws-sdk/client-s3')>()),
  S3Client: class {
    send(command: unknown) {
      return fakeS3.current!.send(command);
    }
  },
}));

// Signing needs a real client; the URL only has to show which object it points at.
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async (_client: unknown, command: { input: { Key: string } }) => `https://signed.test/${command.input.Key}`),
}));

const session = vi.hoisted(() => ({ userId: '' }));
vi.mock('@/lib/auth', () => ({
  verifyAuth: vi.fn(async () => ({ id: session.userId, authentication: null })),
  authenticateRequestWithOptions: vi.fn(async () => ({ userId: session.userId, authentication: null, tokenType: 'session' })),
  isAuthError: () => false,
  checkMCPCreateScope: () => null,
  isScopedMCPAuth: () => false,
}));

// Route-level audit calls are silenced. The lib's own calls (the upload gate's
// `content.upload.blocked`, the alert email) run for real: a workspace package
// is not transformed by vitest, so they cannot be intercepted from here, and
// they are covered by packages/lib/src/content-safety/__tests__/.
vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));

import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { contentBlocks, contentCases } from '@pagespace/db/schema/content-safety';
import { drives, pages } from '@pagespace/db/schema/core';
import { files } from '@pagespace/db/schema/storage';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { evidenceKeyFor } from '@pagespace/lib/content-safety/takedown';
import { FakeS3 } from '@/test/fake-s3';
import { copyAssetToPublishBucket } from '@/lib/canvas/published-storage';
import { GET as viewFile } from '@/app/api/files/[id]/view/route';
import { GET as downloadFile } from '@/app/api/files/[id]/download/route';
import { POST as presignUpload } from '@/app/api/upload/presign/route';
import { executeTakedown } from '../takedown-service';

const UPLOADS = 'it-uploads';
const PUBLISH = 'it-published';
const EVIDENCE = 'it-evidence';

// A harmless stand-in file, unique per run so reruns never collide on the blocklist.
const BYTES = `harmless test file ${randomUUID()}`;
const HASH = createHash('sha256').update(BYTES).digest('hex');

const s3 = new FakeS3();
const created = { userIds: [] as string[], driveIds: [] as string[] };
let admin: string;
let uploader: string;
let otherTenant: string;
let driveId: string;
let pageId: string;
let otherPageId: string;
let caseId: string;

const view = (id: string) =>
  viewFile(new Request(`http://localhost/api/files/${id}/view`) as never, { params: Promise.resolve({ id }) });

describe('content takedown — upload, publish, take down, removed, re-upload refused', () => {
  beforeAll(async () => {
    fakeS3.current = s3;
    vi.stubEnv('BUCKET_NAME', UPLOADS);
    vi.stubEnv('PUBLISH_BUCKET', PUBLISH);
    vi.stubEnv('EVIDENCE_BUCKET', EVIDENCE);
    // No email leaves a test run: on-prem mode makes sendEmail a no-op.
    vi.stubEnv('DEPLOYMENT_MODE', 'onprem');

    try {
      const [a, u, o] = await Promise.all([factories.createUser({ role: 'admin' }), factories.createUser(), factories.createUser()]);
      admin = a.id;
      uploader = u.id;
      otherTenant = o.id;
      created.userIds.push(admin, uploader, otherTenant);
    } catch (error) {
      requireDb('takedown.integration.test.ts', error);
      throw error;
    }

    // 1a. Upload: the bytes land in the uploads bucket, with the rows an upload writes.
    const drive = await factories.createDrive(uploader);
    driveId = drive.id;
    const otherDrive = await factories.createDrive(otherTenant);
    created.driveIds.push(driveId, otherDrive.id);

    s3.put(UPLOADS, `files/${HASH}/original`, BYTES, 'image/png');
    s3.put(UPLOADS, `cache/${HASH}/thumbnail.webp`, 'thumbnail');
    await db.insert(files).values({ id: HASH, driveId, sizeBytes: BYTES.length, mimeType: 'image/png', storagePath: HASH, createdBy: uploader });
    const page = await factories.createPage(driveId, { type: 'FILE', filePath: HASH, contentHash: HASH, mimeType: 'image/png', createdBy: uploader });
    pageId = page.id;
    // A second tenant holds the same bytes: storage is deduplicated by hash.
    const otherPage = await factories.createPage(otherDrive.id, { type: 'FILE', filePath: HASH, contentHash: HASH, mimeType: 'image/png', createdBy: otherTenant });
    otherPageId = otherPage.id;

    // 1b. Publish: the real promotion to the public bucket.
    await copyAssetToPublishBucket({ contentHash: HASH, mimeType: 'image/png' });
    s3.put(PUBLISH, `assets/cache/${HASH}/thumbnail.webp`, 'thumbnail');
  });

  afterAll(async () => {
    await db.delete(contentCases).where(eq(contentCases.contentHash, HASH));
    await db.delete(contentBlocks).where(eq(contentBlocks.contentHash, HASH));
    await db.delete(files).where(eq(files.id, HASH));
    if (created.driveIds.length) await db.delete(drives).where(inArray(drives.id, created.driveIds));
    if (created.userIds.length) await db.delete(users).where(inArray(users.id, created.userIds));
    vi.unstubAllEnvs();
  });

  it('1. before the takedown the file is published and viewable', async () => {
    expect(s3.has(PUBLISH, `assets/${HASH}`)).toBe(true);

    session.userId = uploader;
    const response = await view(pageId);
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain(`files/${HASH}/original`);
  });

  it('2. a global takedown runs every step and finishes the case', async () => {
    const result = await executeTakedown(
      { action: 'global', contentHash: HASH, category: 'csam', reason: 'integration test', suspendUploader: true },
      admin,
    );

    expect(result).toMatchObject({ action: 'global', status: 'actioned' });
    expect(result.failedStep).toBeUndefined();
    caseId = result.caseId!;

    const [row] = await db.select().from(contentCases).where(eq(contentCases.id, caseId));
    expect(row.status).toBe('actioned');
    expect(row.steps?.map((s) => `${s.step}:${s.status}`)).toEqual([
      'block:ok',
      'quarantine_public:ok',
      'preserve:ok',
      'delete_uploads:ok',
      'delete_public:ok',
      'record_references:ok',
      'suspend_uploader:ok',
    ]);
  });

  it('3. the public asset and the private objects are deleted, and the evidence copy exists with the same bytes', async () => {
    expect(s3.keys(PUBLISH)).toEqual([]);
    expect(s3.keys(UPLOADS)).toEqual([]);

    const evidenceKey = evidenceKeyFor(caseId, HASH);
    expect(evidenceKey).toContain(caseId);
    expect(s3.keys(EVIDENCE)).toEqual([evidenceKey]);
    expect(new TextDecoder().decode(s3.bucket(EVIDENCE).get(evidenceKey)!.body)).toBe(BYTES);
  });

  it('3b. the block was written before anything was deleted', async () => {
    const [block] = await db.select().from(contentBlocks).where(eq(contentBlocks.contentHash, HASH));
    expect(block).toMatchObject({ category: 'csam', source: 'admin', caseId, createdBy: admin });

    // The only thing removed before the evidence copy is the PUBLIC key, and only
    // after its bytes were copied into quarantine. Every destructive delete (the
    // batch deletes of both buckets) comes after the verified evidence copy.
    const quarantineCopy = s3.log.findIndex((line) => line === `CopyObjectCommand ${PUBLISH} quarantine/assets/${HASH}`);
    const publicKeyRemoved = s3.log.findIndex((line) => line === `DeleteObjectCommand ${PUBLISH} assets/${HASH}`);
    const evidenceCopy = s3.log.findIndex((line) => line.startsWith(`CopyObjectCommand ${EVIDENCE}`));
    const firstDestructiveDelete = s3.log.findIndex((line) => line.startsWith('DeleteObjectsCommand'));
    expect(quarantineCopy).toBeGreaterThan(-1);
    expect(quarantineCopy).toBeLessThan(publicKeyRemoved);
    expect(evidenceCopy).toBeGreaterThan(publicKeyRemoved);
    expect(evidenceCopy).toBeLessThan(firstDestructiveDelete);
  });

  it('4. the view and download routes answer a neutral 410 instead of a dead link', async () => {
    session.userId = uploader;
    const response = await view(pageId);
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: 'This file has been removed' });

    const download = await downloadFile(new Request(`http://localhost/api/files/${pageId}/download`) as never, {
      params: Promise.resolve({ id: pageId }),
    });
    expect(download.status).toBe(410);
  });

  it('4b. a second tenant holding the same bytes sees "removed" too', async () => {
    session.userId = otherTenant;
    expect((await view(otherPageId)).status).toBe(410);
  });

  it('5. a re-upload of the same bytes is refused by the upload gate', async () => {
    session.userId = otherTenant;
    const [otherDriveId] = created.driveIds.filter((id) => id !== driveId);

    const response = await presignUpload(
      new Request('http://localhost/api/upload/presign', {
        method: 'POST',
        body: JSON.stringify({ contentHash: HASH, driveId: otherDriveId, filename: 'again.png', mimeType: 'image/png', fileSize: BYTES.length }),
      }),
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "This file can't be uploaded" });
    expect(s3.keys(UPLOADS)).toEqual([]);
  });

  it('records every reference on the case, by ID only, and leaves the rows untouched', async () => {
    const [row] = await db.select().from(contentCases).where(eq(contentCases.id, caseId));
    const refs = row.snapshot?.references;

    expect(refs?.pageIds.sort()).toEqual([pageId, otherPageId].sort());
    expect(refs?.fileIds).toEqual([HASH]);
    expect(refs?.driveIds.sort()).toEqual([...created.driveIds].sort());
    expect(refs?.uploaderUserIds.sort()).toEqual([uploader, otherTenant].sort());

    const [page] = await db.select({ filePath: pages.filePath }).from(pages).where(eq(pages.id, pageId));
    expect(page.filePath).toBe(HASH);
    const [file] = await db.select({ id: files.id }).from(files).where(eq(files.id, HASH));
    expect(file.id).toBe(HASH);
  });

  it('suspends the uploaders when asked to, and never the acting admin', async () => {
    const rows = await db.select({ id: users.id, suspendedAt: users.suspendedAt }).from(users).where(inArray(users.id, created.userIds));
    const suspended = rows.filter((r) => r.suspendedAt !== null).map((r) => r.id);
    expect(suspended.sort()).toEqual([uploader, otherTenant].sort());
  });

  it('is idempotent: resuming the finished case touches no storage', async () => {
    const commands = s3.log.length;

    const again = await executeTakedown({ action: 'resume', caseId }, admin);
    expect(again).toMatchObject({ status: 'actioned', caseId });
    expect(s3.log.length).toBe(commands);
  });

  it('a re-sweep removes bytes that land after the takedown through an old presigned PUT', async () => {
    s3.put(UPLOADS, `files/${HASH}/original`, BYTES, 'image/png');

    const result = await executeTakedown({ action: 'resweep', caseId }, null);

    expect(result.status).toBe('actioned');
    expect(s3.keys(UPLOADS)).toEqual([]);
    expect(s3.keys(EVIDENCE)).toEqual([evidenceKeyFor(caseId, HASH)]);
  });
});

describe('content takedown — CSAM with no evidence storage configured', () => {
  const bytes = `harmless test file ${randomUUID()}`;
  const hash = createHash('sha256').update(bytes).digest('hex');
  const ids = { users: [] as string[], drives: [] as string[] };
  let adminId: string;
  let ownerId: string;
  let filePageId: string;
  let waitingCaseId: string;

  beforeAll(async () => {
    fakeS3.current = s3;
    vi.stubEnv('BUCKET_NAME', UPLOADS);
    vi.stubEnv('PUBLISH_BUCKET', PUBLISH);
    vi.stubEnv('EVIDENCE_BUCKET', '');
    vi.stubEnv('DEPLOYMENT_MODE', 'onprem');

    const [a, u] = await Promise.all([factories.createUser({ role: 'admin' }), factories.createUser()]);
    adminId = a.id;
    ownerId = u.id;
    ids.users.push(adminId, ownerId);
    const drive = await factories.createDrive(ownerId);
    ids.drives.push(drive.id);

    s3.put(UPLOADS, `files/${hash}/original`, bytes, 'image/png');
    const page = await factories.createPage(drive.id, { type: 'FILE', filePath: hash, contentHash: hash, mimeType: 'image/png', createdBy: ownerId });
    filePageId = page.id;
    await copyAssetToPublishBucket({ contentHash: hash, mimeType: 'image/png' });
  });

  afterAll(async () => {
    await db.delete(contentCases).where(eq(contentCases.contentHash, hash));
    await db.delete(contentBlocks).where(eq(contentBlocks.contentHash, hash));
    if (ids.drives.length) await db.delete(drives).where(inArray(drives.id, ids.drives));
    if (ids.users.length) await db.delete(users).where(inArray(users.id, ids.users));
    vi.unstubAllEnvs();
  });

  it('blocks the hash and waits, deleting nothing', async () => {
    const result = await executeTakedown({ action: 'global', contentHash: hash, category: 'csam', reason: 'integration test' }, adminId);

    expect(result).toMatchObject({ status: 'awaiting_evidence', haltReason: 'awaiting_evidence' });
    waitingCaseId = result.caseId!;
    expect(s3.has(UPLOADS, `files/${hash}/original`)).toBe(true);
    expect(s3.log.some((line) => line.startsWith('DeleteObjectsCommand') && line.includes(hash))).toBe(false);
  });

  it('but the content is already off the web: the public copy is in quarantine, not under assets/', async () => {
    expect(s3.has(PUBLISH, `assets/${hash}`)).toBe(false);
    expect(s3.has(PUBLISH, `quarantine/assets/${hash}`)).toBe(true);
  });

  it('and already unreadable in the app: the view route answers 410 while the bytes still exist', async () => {
    session.userId = ownerId;
    expect((await view(filePageId)).status).toBe(410);
  });

  it('and cannot be published again while it waits', async () => {
    await expect(copyAssetToPublishBucket({ contentHash: hash, mimeType: 'image/png' })).rejects.toThrow(
      'This file is not available for publishing',
    );
    expect(s3.has(PUBLISH, `assets/${hash}`)).toBe(false);
  });

  it('finishes when evidence storage is configured and the case is resumed', async () => {
    vi.stubEnv('EVIDENCE_BUCKET', EVIDENCE);

    const result = await executeTakedown({ action: 'resume', caseId: waitingCaseId }, adminId);

    expect(result).toMatchObject({ status: 'actioned', caseId: waitingCaseId });
    expect(new TextDecoder().decode(s3.bucket(EVIDENCE).get(evidenceKeyFor(waitingCaseId, hash))!.body)).toBe(bytes);
    expect(s3.keys(UPLOADS).filter((key) => key.includes(hash))).toEqual([]);
    expect(s3.keys(PUBLISH).filter((key) => key.includes(hash))).toEqual([]);
  });
});
