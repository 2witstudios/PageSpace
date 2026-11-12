import { DeleteObjectsCommand, HeadObjectCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';

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
