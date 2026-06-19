import 'server-only';

import { S3Client, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getS3Client, getS3Bucket } from '@/lib/presigned-url';

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

// ---------------------------------------------------------------------------
// Asset pipeline helpers (CDN copy of embedded PageSpace files)
// ---------------------------------------------------------------------------

/**
 * Build the S3 object key for a content-addressed asset in the publish bucket.
 *
 * Assets are keyed by content hash so:
 *  - identical files share a single object (no duplication)
 *  - re-publishing the same canvas is fully idempotent
 *  - orphaned keys are harmless (same content, never an old/wrong version)
 */
export function buildAssetKey(contentHash: string): string {
  return `assets/${contentHash}`;
}

/**
 * Resolve the public base URL for CDN assets.
 *
 * Priority:
 *  1. `PUBLISH_ASSET_BASE_URL` — explicit override (e.g. a custom CDN)
 *  2. Derived from `PUBLISH_BUCKET` → `https://{bucket}.t3.tigrisfiles.io`
 *     (Tigris public domain; anonymous GET works here — NOT the authed S3 endpoint)
 *  3. Throws if neither is set.
 */
export function getPublishAssetBaseUrl(): string {
  if (process.env.PUBLISH_ASSET_BASE_URL) {
    return process.env.PUBLISH_ASSET_BASE_URL;
  }
  const bucket = process.env.PUBLISH_BUCKET;
  if (!bucket) {
    throw new Error(
      'Cannot derive asset base URL: PUBLISH_BUCKET is not configured and PUBLISH_ASSET_BASE_URL is not set',
    );
  }
  return `https://${bucket}.t3.tigrisfiles.io`;
}

/**
 * Build the full public URL for a content-addressed asset.
 *
 * Trailing slashes in the base URL are normalised so the result never contains
 * a double slash.
 */
export function buildAssetUrl(contentHash: string): string {
  const base = getPublishAssetBaseUrl();
  const trimmedBase = base.endsWith('/') ? base.slice(0, -1) : base;
  return `${trimmedBase}/${buildAssetKey(contentHash)}`;
}

/**
 * Copy a file from the private uploads bucket to the public CDN publish bucket.
 *
 * Content-addressed: if the asset key already exists in the publish bucket
 * (HeadObject → 200) the copy is skipped — the bytes are identical by hash.
 * This makes concurrent publishes fully idempotent.
 *
 * Private key: `files/{contentHash}/original` (standard Tigris upload layout).
 * Public key:  `assets/{contentHash}` (via buildAssetKey).
 */
export async function copyAssetToPublishBucket(params: {
  contentHash: string;
  mimeType: string;
}): Promise<void> {
  const { contentHash, mimeType } = params;
  const assetKey = buildAssetKey(contentHash);
  const publishBucket = getPublishBucket();

  // Dedup check — content-addressed, so existence = already correct
  try {
    await getPublishClient().send(new HeadObjectCommand({ Bucket: publishBucket, Key: assetKey }));
    return;
  } catch (err: unknown) {
    const anyErr = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    const is404 =
      anyErr?.name === 'NotFound' ||
      anyErr?.name === 'NoSuchKey' ||
      anyErr?.$metadata?.httpStatusCode === 404;
    if (!is404) throw err;
    // Not found — proceed with copy
  }

  const privateKey = `files/${contentHash}/original`;
  const getResult = await getS3Client().send(
    new GetObjectCommand({ Bucket: getS3Bucket(), Key: privateKey }),
  );

  const body = getResult.Body
    ? await (getResult.Body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray()
    : new Uint8Array(0);

  await getPublishClient().send(
    new PutObjectCommand({
      Bucket: publishBucket,
      Key: assetKey,
      Body: body,
      ContentType: mimeType,
    }),
  );
}
