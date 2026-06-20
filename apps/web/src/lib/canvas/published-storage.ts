import 'server-only';

import { S3Client, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getS3Client, getS3Bucket } from '@/lib/presigned-url';

const CONTENT_HASH_RE = /^[0-9a-f]{64}$/i;
const THUMBNAIL_SOURCE_KEY_RE = /^cache\/[0-9a-f]+\/thumbnail\.webp$/i;
const FILE_SOURCE_KEY_RE = /^files\/[0-9a-f]{64}\/original$/i;
const ASSET_KEY_RE = /^assets\/(?:[0-9a-f]{64}|cache\/[0-9a-f]+\/thumbnail\.webp)$/i;

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

function assertContentHash(contentHash: string): string {
  if (!CONTENT_HASH_RE.test(contentHash)) {
    throw new Error('Invalid content hash for public asset key');
  }
  return contentHash.toLowerCase();
}

function assertPublicAssetOrigin(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error('Public asset origin must be a valid HTTPS URL');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Public asset origin must use HTTPS');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Public asset origin must not include credentials');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('Public asset origin must not include query or fragment components');
  }
  if (parsed.pathname !== '/') {
    throw new Error('Public asset origin must not include path components');
  }

  return parsed.origin;
}

function assertAssetKey(assetKey: string): string {
  if (!ASSET_KEY_RE.test(assetKey)) {
    throw new Error('Invalid public asset key');
  }
  return assetKey;
}

function assertPrivateSourceKey(sourceKey: string): string {
  if (!FILE_SOURCE_KEY_RE.test(sourceKey) && !THUMBNAIL_SOURCE_KEY_RE.test(sourceKey)) {
    throw new Error('Invalid private source key');
  }
  return sourceKey;
}

export function getPublicAssetHost(assetBaseUrl: string): string {
  return new URL(assertPublicAssetOrigin(assetBaseUrl)).host;
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
  return `assets/${assertContentHash(contentHash)}`;
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
    return assertPublicAssetOrigin(process.env.PUBLISH_ASSET_BASE_URL);
  }
  const bucket = process.env.PUBLISH_BUCKET;
  if (!bucket) {
    throw new Error(
      'Cannot derive asset base URL: PUBLISH_BUCKET is not configured and PUBLISH_ASSET_BASE_URL is not set',
    );
  }
  return assertPublicAssetOrigin(`https://${bucket}.t3.tigrisfiles.io`);
}

/**
 * Build the full public URL for a content-addressed asset.
 *
 * Trailing slashes in the base URL are normalised so the result never contains
 * a double slash.
 */
export function buildAssetUrl(contentHash: string): string {
  return buildAssetUrlFromKey(buildAssetKey(contentHash));
}

/**
 * Build the full public URL for an already-resolved publish-bucket asset key.
 */
export function buildAssetUrlFromKey(assetKey: string): string {
  const base = getPublishAssetBaseUrl();
  const trimmedBase = base.endsWith('/') ? base.slice(0, -1) : base;
  return `${trimmedBase}/${assertAssetKey(assetKey)}`;
}

/**
 * Copy an object from private file storage to a public publish-bucket asset key.
 */
export async function copyObjectToPublishBucket(params: {
  sourceKey: string;
  assetKey: string;
  contentType: string;
}): Promise<void> {
  const sourceKey = assertPrivateSourceKey(params.sourceKey);
  const assetKey = assertAssetKey(params.assetKey);
  const { contentType } = params;
  const publishBucket = getPublishBucket();

  // Dedup check — existence at the resolved public key means it was already promoted.
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
  }

  const getResult = await getS3Client().send(
    new GetObjectCommand({ Bucket: getS3Bucket(), Key: sourceKey }),
  );

  const body = getResult.Body
    ? await (getResult.Body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray()
    : new Uint8Array(0);

  await getPublishClient().send(
    new PutObjectCommand({
      Bucket: publishBucket,
      Key: assetKey,
      Body: body,
      ContentType: contentType,
    }),
  );
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
  await copyObjectToPublishBucket({
    sourceKey: `files/${contentHash}/original`,
    assetKey: buildAssetKey(contentHash),
    contentType: mimeType,
  });
}
