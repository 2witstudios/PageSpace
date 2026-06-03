import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { test, expect } from '../fixtures/auth.fixture';
import { getSeedState } from '../fixtures/seed-state';

const requiredEnv = [
  'DATABASE_URL',
];

const getBucketName = () =>
  process.env.BUCKET_NAME ?? process.env.TIGRIS_BUCKET ?? process.env.S3_BUCKET ?? '';

const hasRealStorageEnv = () =>
  process.env.E2E_REAL_STORAGE === '1' &&
  requiredEnv.every((key) => Boolean(process.env[key]));

const canCleanupS3Objects = () =>
  Boolean(
    process.env.AWS_ACCESS_KEY_ID &&
      process.env.AWS_SECRET_ACCESS_KEY &&
      process.env.AWS_ENDPOINT_URL_S3 &&
      getBucketName()
  );

const createS3Client = () =>
  new S3Client({
    region: process.env.AWS_REGION ?? 'auto',
    endpoint: process.env.AWS_ENDPOINT_URL_S3,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  });

const assertSafeE2EBucket = () => {
  const bucket = getBucketName();
  if (/prod/i.test(bucket) && process.env.E2E_REAL_STORAGE_ALLOW_PROD !== '1') {
    throw new Error(
      `Refusing to run real-storage E2E against bucket "${bucket}" without E2E_REAL_STORAGE_ALLOW_PROD=1`
    );
  }
  return bucket;
};

async function readStorageUsedBytes(userId: string): Promise<number> {
  const [user] = await db
    .select({ storageUsedBytes: users.storageUsedBytes })
    .from(users)
    .where(eq(users.id, userId));

  if (!user) throw new Error(`Seed user not found: ${userId}`);
  return user.storageUsedBytes;
}

async function deleteUploadedObjects(contentHash: string): Promise<void> {
  if (!canCleanupS3Objects()) return;

  const bucket = getBucketName();
  const s3 = createS3Client();
  await Promise.all([
    s3.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: `files/${contentHash}/original`,
      })
    ),
    s3.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: `files/${contentHash}/metadata.json`,
      })
    ),
  ]);
}

test.describe('Real storage file uploads', () => {
  test.skip(
    !hasRealStorageEnv(),
    'Set E2E_REAL_STORAGE=1 plus DATABASE_URL and Tigris/S3 env vars to run real storage E2E.'
  );

  test('given real S3 storage, should upload, account, redirect, and fetch original bytes', async ({
    page,
    driveId,
  }) => {
    assertSafeE2EBucket();

    const { userId } = getSeedState();
    const fileName = `pagespace-real-storage-${randomUUID()}.txt`;
    const fileBuffer = Buffer.from(`PageSpace real storage E2E ${randomUUID()}\n`, 'utf-8');
    const expectedContentHash = createHash('sha256').update(fileBuffer).digest('hex');
    const beforeUsedBytes = await readStorageUsedBytes(userId);

    try {
      const csrfResponse = await page.request.get('/api/auth/csrf');
      expect(csrfResponse.status()).toBe(200);
      const { csrfToken } = (await csrfResponse.json()) as { csrfToken: string };

      // 1. Presign a PUT scoped to this exact hash + size.
      const presignResponse = await page.request.post('/api/upload/presign', {
        headers: { 'X-CSRF-Token': csrfToken },
        data: {
          contentHash: expectedContentHash,
          driveId,
          filename: fileName,
          mimeType: 'text/plain',
          fileSize: fileBuffer.length,
        },
      });
      expect(presignResponse.status()).toBe(200);
      const presign = (await presignResponse.json()) as {
        jobId: string;
        url?: string;
        alreadyExists?: boolean;
      };
      expect(presign.jobId).toBeTruthy();

      // 2. Upload the bytes straight to Tigris (skipped on the dedup path).
      if (!presign.alreadyExists) {
        expect(presign.url).toBeTruthy();
        const putResponse = await page.request.put(presign.url!, {
          headers: { 'Content-Type': 'text/plain' },
          data: fileBuffer,
        });
        expect([200, 204]).toContain(putResponse.status());
      }

      // 3. Complete: create the page record from the trusted, presign-reserved slot.
      const completeResponse = await page.request.post('/api/upload/complete', {
        headers: { 'X-CSRF-Token': csrfToken },
        data: { jobId: presign.jobId, title: fileName, parentId: null },
      });
      expect(completeResponse.status()).toBe(200);
      const uploadBody = (await completeResponse.json()) as {
        page?: { id?: string; contentHash?: string; filePath?: string };
      };
      const pageId = uploadBody.page?.id;

      expect(pageId).toBeTruthy();
      expect(uploadBody.page?.contentHash).toBe(expectedContentHash);
      expect(uploadBody.page?.filePath).toBe(expectedContentHash);
      await expect.poll(() => readStorageUsedBytes(userId)).toBeGreaterThanOrEqual(
        beforeUsedBytes + fileBuffer.length
      );

      const viewResponse = await page.request.get(`/api/files/${pageId}/view`, {
        maxRedirects: 0,
      });
      expect(viewResponse.status()).toBe(307);
      const viewLocation = viewResponse.headers()['location'];
      expect(viewLocation).toContain(expectedContentHash);

      const objectResponse = await page.request.get(viewLocation);
      expect(objectResponse.status()).toBe(200);
      expect(Buffer.from(await objectResponse.body()).equals(fileBuffer)).toBe(true);

      const downloadResponse = await page.request.get(`/api/files/${pageId}/download`, {
        maxRedirects: 0,
      });
      expect(downloadResponse.status()).toBe(307);
      const downloadUrl = new URL(downloadResponse.headers()['location']);
      expect(downloadUrl.searchParams.get('response-content-disposition')).toContain('attachment');
      expect(downloadUrl.searchParams.get('response-content-disposition')).toContain(fileName);
    } finally {
      await deleteUploadedObjects(expectedContentHash);
    }
  });
});
