import 'server-only';

import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

/**
 * Storage helper for PUBLISHED canvas artifacts.
 *
 * Published pages are PUBLIC, so they live in their own dedicated public bucket
 * (`PUBLISH_BUCKET`, e.g. `pagespace-published`) — intentionally SEPARATE from the
 * private uploads bucket (`pagespace-files`, served via presigned URLs). We must
 * never write published artifacts into the uploads bucket: making that bucket
 * (or a prefix of it) public-read would expose private user files.
 *
 * Layout: `published/<subdomain>/<cleanPath>/index.html`. The edge serves
 * `index.html` for the matching request path. The subdomain is assumed to have
 * already been validated/normalized by the caller (see
 * `@pagespace/lib/validators/subdomain`).
 */

let _client: S3Client | null = null;

/** Lazily build the S3 client for the dedicated public publish bucket. */
function getPublishClient(): S3Client {
  if (!_client) {
    _client = new S3Client({
      region: process.env.PUBLISH_S3_REGION ?? 'auto',
      endpoint: process.env.PUBLISH_S3_ENDPOINT,
      credentials:
        process.env.PUBLISH_S3_ACCESS_KEY_ID && process.env.PUBLISH_S3_SECRET_ACCESS_KEY
          ? {
              accessKeyId: process.env.PUBLISH_S3_ACCESS_KEY_ID,
              secretAccessKey: process.env.PUBLISH_S3_SECRET_ACCESS_KEY,
            }
          : undefined,
    });
  }
  return _client;
}

/** Name of the dedicated public publish bucket. Throws if not configured. */
function getPublishBucket(): string {
  const bucket = process.env.PUBLISH_BUCKET;
  if (!bucket) {
    throw new Error('PUBLISH_BUCKET is not configured (dedicated public bucket for canvas publishing)');
  }
  return bucket;
}

/**
 * Whether publish storage is configured. Callers should check this BEFORE any
 * DB reservation so a missing bucket can't leave a `published_pages` row that
 * points at a non-existent object.
 */
export function isPublishConfigured(): boolean {
  return Boolean(process.env.PUBLISH_BUCKET);
}

/**
 * Sanitize a request path into a clean, traversal-safe path segment list.
 * Lowercases, splits on `/`, and drops empty, `.`, and `..` segments so the
 * resulting key can never escape the `published/<subdomain>/` prefix.
 */
function sanitizePath(path: string): string {
  return path
    .toLowerCase()
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .join('/');
}

/**
 * Build the S3 object key for a published page artifact.
 *
 * Root path ('' or traversal-only input) → `published/<subdomain>/index.html`.
 * Nested path → `published/<subdomain>/<cleanPath>/index.html`.
 */
export function buildPublishedKey(subdomain: string, path: string): string {
  const cleanPath = sanitizePath(path);
  return cleanPath
    ? `published/${subdomain}/${cleanPath}/index.html`
    : `published/${subdomain}/index.html`;
}

/**
 * Upload a rendered published-page HTML document to the public publish bucket.
 */
export async function putPublishedArtifact(params: {
  subdomain: string;
  path: string;
  html: string;
}): Promise<{ key: string }> {
  const key = buildPublishedKey(params.subdomain, params.path);

  await getPublishClient().send(
    new PutObjectCommand({
      Bucket: getPublishBucket(),
      Key: key,
      Body: params.html,
      ContentType: 'text/html; charset=utf-8',
    }),
  );

  return { key };
}

/**
 * Delete a previously-published artifact by its storage key.
 */
export async function deletePublishedArtifact(key: string): Promise<void> {
  await getPublishClient().send(
    new DeleteObjectCommand({
      Bucket: getPublishBucket(),
      Key: key,
    }),
  );
}
