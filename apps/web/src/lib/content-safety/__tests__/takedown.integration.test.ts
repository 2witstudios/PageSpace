/**
 * Content takedown, end to end — REAL Postgres, with the S3 clients faked at
 * the SDK boundary (one in-memory store standing in for the uploads, publish
 * and evidence buckets).
 *
 *   1. upload a file and publish it — through the real route handlers:
 *      POST /api/upload/presign, the client's PUT (into the fake bucket),
 *      POST /api/upload/complete, then POST /api/pages/[pageId]/publish for a
 *      canvas page that embeds the file
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
  checkMCPPageScope: async () => null,
  isScopedMCPAuth: () => false,
  // The signed-in user is the drive owner in every call below; the permission
  // rules themselves have their own suites.
  canPrincipalEditPage: async () => true,
  canPrincipalViewPage: async () => true,
}));

// Route-level audit calls are silenced. The lib's own calls (the upload gate's
// `content.upload.blocked`, the alert email) run for real: a workspace package
// is not transformed by vitest, so they cannot be intercepted from here, and
// they are covered by packages/lib/src/content-safety/__tests__/.
const auditCalls = vi.hoisted(() => [] as Array<{ eventType: string; resourceId?: string; userId?: string; details?: Record<string, unknown> }>);
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  audit: vi.fn((event: (typeof auditCalls)[number]) => void auditCalls.push(event)),
  auditRequest: vi.fn(),
}));

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
import { POST as completeUpload } from '@/app/api/upload/complete/route';
import { POST as publishPage } from '@/app/api/pages/[pageId]/publish/route';
import { publishedPages } from '@pagespace/db/schema/published-pages';
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
let adminHolder: string;
let driveId: string;
let pageId: string;
let canvasPageId: string;
let otherPageId: string;
let caseId: string;

const view = (id: string) =>
  viewFile(new Request(`http://localhost/api/files/${id}/view`) as never, { params: Promise.resolve({ id }) });

const json = (url: string, body: unknown) =>
  new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('content takedown — upload, publish, take down, removed, re-upload refused', () => {
  beforeAll(async () => {
    fakeS3.current = s3;
    vi.stubEnv('BUCKET_NAME', UPLOADS);
    vi.stubEnv('PUBLISH_BUCKET', PUBLISH);
    vi.stubEnv('EVIDENCE_BUCKET', EVIDENCE);
    // No email leaves a test run: on-prem mode makes sendEmail a no-op.
    vi.stubEnv('DEPLOYMENT_MODE', 'onprem');
    // The processor is a separate service: upload-complete only enqueues a job there.
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true })));

    try {
      const [a, u, o, h] = await Promise.all([
        factories.createUser({ role: 'admin' }),
        factories.createUser(),
        factories.createUser(),
        factories.createUser({ role: 'admin' }),
      ]);
      admin = a.id;
      uploader = u.id;
      otherTenant = o.id;
      adminHolder = h.id;
      created.userIds.push(admin, uploader, otherTenant, adminHolder);
    } catch (error) {
      requireDb('takedown.integration.test.ts', error);
      throw error;
    }

    const drive = await factories.createDrive(uploader);
    driveId = drive.id;
    const otherDrive = await factories.createDrive(otherTenant);
    const adminDrive = await factories.createDrive(adminHolder);
    created.driveIds.push(driveId, otherDrive.id, adminDrive.id);

    // Two more accounts already hold the same bytes (storage is deduplicated by
    // hash): another tenant, and an admin. These are fixtures, seeded directly.
    const otherPage = await factories.createPage(otherDrive.id, { type: 'FILE', filePath: HASH, contentHash: HASH, mimeType: 'image/png', createdBy: otherTenant });
    otherPageId = otherPage.id;
    await factories.createPage(adminDrive.id, { type: 'FILE', filePath: HASH, contentHash: HASH, mimeType: 'image/png', createdBy: adminHolder });
  });

  afterAll(async () => {
    await db.delete(contentCases).where(eq(contentCases.contentHash, HASH));
    await db.delete(contentBlocks).where(eq(contentBlocks.contentHash, HASH));
    await db.delete(files).where(eq(files.id, HASH));
    if (created.driveIds.length) await db.delete(drives).where(inArray(drives.id, created.driveIds));
    if (created.userIds.length) await db.delete(users).where(inArray(users.id, created.userIds));
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('1a. uploads the file through presign, the PUT, and complete', async () => {
    session.userId = uploader;

    const presign = await presignUpload(
      json('http://localhost/api/upload/presign', { contentHash: HASH, driveId, filename: 'photo.png', mimeType: 'image/png', fileSize: BYTES.length }),
    );
    expect(presign.status).toBe(200);
    const { jobId, url } = (await presign.json()) as { jobId: string; url: string };
    expect(url).toContain(`files/${HASH}/original`);

    // The browser's PUT to the presigned URL.
    s3.put(UPLOADS, `files/${HASH}/original`, BYTES, 'image/png');

    const complete = await completeUpload(json('http://localhost/api/upload/complete', { jobId, title: 'photo.png' }));
    expect(complete.status).toBeLessThan(300);

    const [page] = await db.select({ id: pages.id }).from(pages).where(eq(pages.driveId, driveId));
    pageId = page.id;
    const [file] = await db.select({ id: files.id, createdBy: files.createdBy }).from(files).where(eq(files.id, HASH));
    expect(file).toEqual({ id: HASH, createdBy: uploader });
  });

  it('1b. publishes a canvas page that embeds it, which promotes the file to the public bucket', async () => {
    session.userId = uploader;
    const canvas = await factories.createPage(driveId, {
      type: 'CANVAS',
      title: 'Gallery',
      content: `<html><body><img src="/api/files/${pageId}/view"></body></html>`,
      createdBy: uploader,
    });
    canvasPageId = canvas.id;

    const response = await publishPage(json(`http://localhost/api/pages/${canvasPageId}/publish`, {}), {
      params: Promise.resolve({ pageId: canvasPageId }),
    });
    expect(response.status).toBe(200);

    expect(s3.has(PUBLISH, `assets/${HASH}`)).toBe(true);
    const [published] = await db.select({ key: publishedPages.artifactKey }).from(publishedPages).where(eq(publishedPages.pageId, canvasPageId));
    expect(s3.has(PUBLISH, published.key)).toBe(true);
    // A derived thumbnail the processor would have made and publish would have promoted.
    s3.put(UPLOADS, `cache/${HASH}/thumbnail.webp`, 'thumbnail');
    s3.put(PUBLISH, `assets/cache/${HASH}/thumbnail.webp`, 'thumbnail');
  });

  it('1c. before the takedown the file is viewable', async () => {
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
      'unpublish_public:ok',
      'record_references:ok',
      'preserve:ok',
      'delete_uploads:ok',
      'delete_public:ok',
      'record_ai_references:ok',
      'suspend_uploader:ok',
    ]);
  });

  it('3. the public asset and the private objects are deleted, and the evidence copy exists with the same bytes', async () => {
    expect(s3.keys(PUBLISH).filter((key) => key.includes(HASH))).toEqual([]);
    expect(s3.keys(UPLOADS)).toEqual([]);

    const evidenceKey = evidenceKeyFor(caseId, HASH);
    expect(evidenceKey).toContain(caseId);
    expect(s3.keys(EVIDENCE)).toEqual([evidenceKey]);
    expect(new TextDecoder().decode(s3.bucket(EVIDENCE).get(evidenceKey)!.body)).toBe(BYTES);
  });

  it('3b. the block came first, and nothing private was deleted before the evidence copy was made', async () => {
    const [block] = await db.select().from(contentBlocks).where(eq(contentBlocks.contentHash, HASH));
    expect(block).toMatchObject({ category: 'csam', source: 'admin', caseId, createdBy: admin });

    const evidenceCopy = s3.log.findIndex((line) => line.startsWith(`CopyObjectCommand ${EVIDENCE}`));
    const firstPrivateDelete = s3.log.findIndex((line) => line.startsWith('Delete') && line.includes(` ${UPLOADS} `));
    expect(evidenceCopy).toBeGreaterThan(-1);
    expect(evidenceCopy).toBeLessThan(firstPrivateDelete);
    // A private original existed, so the public copy needed no hold copy and nothing was ever parked in the public bucket.
    expect(s3.log.some((line) => line.startsWith('PutObjectCommand') && line.includes('content-hold/'))).toBe(false);
    expect(s3.log.some((line) => /^(Put|Copy)ObjectCommand/.test(line) && line.includes(` ${PUBLISH} `) && line.includes(HASH) && s3.log.indexOf(line) > evidenceCopy)).toBe(false);
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
    const otherDriveId = created.driveIds[1];

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

    expect(refs?.pageIds).toEqual(expect.arrayContaining([pageId, otherPageId]));
    expect(refs?.pageIds).toHaveLength(3);
    expect(refs?.fileIds).toEqual([HASH]);
    expect(refs?.driveIds.sort()).toEqual([...created.driveIds].sort());
    expect(refs?.uploaderUserIds.sort()).toEqual([uploader, otherTenant, adminHolder].sort());

    const [page] = await db.select({ filePath: pages.filePath }).from(pages).where(eq(pages.id, pageId));
    expect(page.filePath).toBe(HASH);
    const [file] = await db.select({ id: files.id }).from(files).where(eq(files.id, HASH));
    expect(file.id).toBe(HASH);
  });

  it('suspends the uploaders when asked to — but never an admin, and never the acting admin', async () => {
    const rows = await db.select({ id: users.id, suspendedAt: users.suspendedAt }).from(users).where(inArray(users.id, created.userIds));
    const suspended = rows.filter((r) => r.suspendedAt !== null).map((r) => r.id);
    expect(suspended.sort()).toEqual([uploader, otherTenant].sort());

    const [row] = await db.select().from(contentCases).where(eq(contentCases.id, caseId));
    const detail = row.steps?.find((s) => s.step === 'suspend_uploader')?.detail ?? '';
    expect(detail).toContain(`${adminHolder}:skipped_admin`);
    expect(detail).toContain(`${uploader}:suspended`);
  });

  it('audits each suspension the takedown made as the acting admin, and none for the admin it skipped', async () => {
    const suspensions = auditCalls.filter((event) => event.eventType === 'admin.user.suspended');

    expect(suspensions.map((event) => event.resourceId).sort()).toEqual([uploader, otherTenant].sort());
    for (const event of suspensions) {
      expect(event.userId).toBe(admin);
      expect(event.details).toMatchObject({ source: 'content_takedown', action: 'suspend' });
    }
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

  it('but the content is already off the web: its public copy is deleted, and nothing was parked in the public bucket', async () => {
    expect(s3.keys(PUBLISH).filter((key) => key.includes(hash))).toEqual([]);
    expect(s3.has(UPLOADS, `files/${hash}/original`)).toBe(true);
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

  it('and who uploaded it is already on the case, before anything else could remove that record', async () => {
    const [row] = await db.select().from(contentCases).where(eq(contentCases.id, waitingCaseId));
    expect(row.snapshot?.references?.uploaderUserIds).toEqual([ownerId]);
    expect(row.snapshot?.references?.pageIds).toEqual([filePageId]);
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
