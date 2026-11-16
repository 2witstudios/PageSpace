import { createHash } from 'crypto';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getS3Client, getS3Bucket } from '@/lib/presigned-url';

export async function checkObjectExists(key: string): Promise<boolean> {
  try {
    await getS3Client().send(new HeadObjectCommand({ Bucket: getS3Bucket(), Key: key }));
    return true;
  } catch (err: unknown) {
    if (err instanceof Error && (err.name === 'NotFound' || err.name === 'NoSuchKey')) {
      return false;
    }
    // 404 from AWS SDK v3 also surfaces as $metadata.httpStatusCode
    const anyErr = err as { $metadata?: { httpStatusCode?: number } };
    if (anyErr?.$metadata?.httpStatusCode === 404) return false;
    throw err;
  }
}

function isNotFound(err: unknown): boolean {
  if (err instanceof Error && (err.name === 'NotFound' || err.name === 'NoSuchKey')) return true;
  return (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404;
}

export type StoredObjectDigest =
  | { status: 'missing' }
  | { status: 'oversize' }
  | { status: 'ok'; sha256: string; size: number };

/**
 * SHA-256 of the object stored under `key`, streamed (constant memory) and
 * stopped as soon as it passes `maxBytes` — the size reserved at presign — so a
 * caller can't make the server read more than it agreed to accept.
 */
export async function digestStoredObject(key: string, maxBytes: number): Promise<StoredObjectDigest> {
  let body: AsyncIterable<Uint8Array>;
  try {
    const response = await getS3Client().send(new GetObjectCommand({ Bucket: getS3Bucket(), Key: key }));
    if (!response.Body) return { status: 'missing' };
    body = response.Body as AsyncIterable<Uint8Array>;
  } catch (err: unknown) {
    if (isNotFound(err)) return { status: 'missing' };
    throw err;
  }
  const hash = createHash('sha256');
  let size = 0;
  const iterator = body[Symbol.asyncIterator]();
  for (;;) {
    const { value, done } = await iterator.next();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await iterator.return?.();
      return { status: 'oversize' };
    }
    hash.update(value);
  }
  return { status: 'ok', sha256: hash.digest('hex'), size };
}

export async function deleteStoredObject(key: string): Promise<void> {
  await getS3Client().send(new DeleteObjectCommand({ Bucket: getS3Bucket(), Key: key }));
}

export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  await getS3Client().send(new PutObjectCommand({ Bucket: getS3Bucket(), Key: key, Body: body, ContentType: contentType }));
}

export async function issuePresignedPutUrl(
  key: string,
  contentType: string,
  fileSize: number,
  ttlSeconds: number,
): Promise<string> {
  // Zero-trust: ContentLength is signed into the URL, so S3/Tigris rejects any
  // PUT whose body size differs from the declared fileSize. (content-length-range
  // is a presigned-POST policy condition and is silently ignored on a PUT command.)
  const command = new PutObjectCommand({
    Bucket: getS3Bucket(),
    Key: key,
    ContentType: contentType,
    ContentLength: fileSize,
  });

  return getSignedUrl(getS3Client(), command, { expiresIn: ttlSeconds });
}
