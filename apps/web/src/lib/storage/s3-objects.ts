import { DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';

/**
 * Small S3 primitives shared by the code that works on whole key prefixes
 * (content takedown in both buckets). They take the client and bucket, so the
 * uploads bucket and the publish bucket — which may sit behind different
 * credentials — use the same implementation.
 */

export interface S3ObjectInfo {
  key: string;
  size: number;
}

/** Not-found from HeadObject / GetObject, in any of the shapes the SDK reports it. */
export function isS3NotFound(err: unknown): boolean {
  const anyErr = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return anyErr?.name === 'NotFound' || anyErr?.name === 'NoSuchKey' || anyErr?.$metadata?.httpStatusCode === 404;
}

/**
 * An object's key and size, or null on a definite not-found. Any other failure
 * throws: "couldn't check" must never read as "nothing there".
 */
export async function headS3Object(client: S3Client, bucket: string, key: string): Promise<S3ObjectInfo | null> {
  try {
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { key, size: head.ContentLength ?? 0 };
  } catch (err) {
    if (isS3NotFound(err)) return null;
    throw err;
  }
}

/** Every object under a prefix, across all pages of the listing. */
export async function listS3Prefix(client: S3Client, bucket: string, prefix: string): Promise<S3ObjectInfo[]> {
  const objects: S3ObjectInfo[] = [];
  let continuationToken: string | undefined;
  do {
    const listed = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken }),
    );
    for (const obj of listed.Contents ?? []) if (obj.Key) objects.push({ key: obj.Key, size: obj.Size ?? 0 });
    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);
  return objects;
}

/**
 * Delete the given keys, in batches of 1000. Not `Quiet`: a partial failure
 * throws, so a caller's step is retried rather than counted as done.
 */
export async function deleteS3Keys(client: S3Client, bucket: string, keys: readonly string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 1000) {
    const result = await client.send(
      new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })) } }),
    );
    if (result.Errors && result.Errors.length > 0) {
      throw new Error(`Failed to delete ${result.Errors.length} object(s)`);
    }
  }
}

/** One page of a listing, in key order, after `startAfter`. A stable cursor: unlike a continuation token, a key never expires. */
export async function listS3Page(
  client: S3Client,
  bucket: string,
  prefix: string,
  startAfter: string | null,
  maxKeys: number,
): Promise<{ objects: S3ObjectInfo[]; truncated: boolean }> {
  const listed = await client.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: maxKeys, ...(startAfter ? { StartAfter: startAfter } : {}) }),
  );
  const objects = (listed.Contents ?? []).flatMap((obj) => (obj.Key ? [{ key: obj.Key, size: obj.Size ?? 0 }] : []));
  return { objects, truncated: Boolean(listed.IsTruncated) };
}

/** Bytes read from an object over the size bound: enough to recognise its type. */
export const SNIFF_BYTES = 4096;

async function bodyBytes(body: unknown): Promise<Uint8Array> {
  const whole = body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
  if (whole && typeof whole.transformToByteArray === 'function') return whole.transformToByteArray();
  return new Uint8Array(0);
}

/**
 * An object's bytes when they fit under `maxBytes`, else only its first bytes (`complete: false`): a large
 * object is never buffered. HEAD first; an unknown size is treated as too large. Null on a definite not-found.
 */
export async function readS3ObjectBounded(
  client: S3Client,
  bucket: string,
  key: string,
  maxBytes: number,
  timeoutMs: number,
): Promise<{ bytes: Uint8Array; complete: boolean } | null> {
  let size: number;
  try {
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(timeoutMs) });
    size = head.ContentLength ?? Number.MAX_SAFE_INTEGER;
  } catch (err) {
    if (isS3NotFound(err)) return null;
    throw err;
  }
  const tooLarge = size > maxBytes;
  try {
    const result = await client.send(
      // Ranged either way: an object that grew after the HEAD is never buffered past the bound.
      new GetObjectCommand({ Bucket: bucket, Key: key, Range: tooLarge ? `bytes=0-${SNIFF_BYTES - 1}` : `bytes=0-${maxBytes}` }),
      { abortSignal: AbortSignal.timeout(timeoutMs) },
    );
    const bytes = await bodyBytes(result.Body);
    // The object may have been replaced between the HEAD and the GET.
    if (bytes.length > maxBytes) return { bytes: bytes.subarray(0, SNIFF_BYTES), complete: false };
    return { bytes, complete: !tooLarge };
  } catch (err) {
    if (isS3NotFound(err)) return null;
    throw err;
  }
}
