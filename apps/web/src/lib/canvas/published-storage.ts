import 'server-only';

import { PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getS3Client, getS3Bucket } from '@/lib/presigned-url';

/**
 * Storage helper for PUBLISHED canvas artifacts.
 *
 * Published pages are written to S3/Tigris under a clean-URL / folder
 * convention: `published/<subdomain>/<cleanPath>/index.html`. The edge serves
 * `index.html` for the matching request path. The subdomain is assumed to have
 * already been validated/normalized by the caller (see
 * `@pagespace/lib/validators/subdomain`).
 */

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
 * Upload a rendered published-page HTML document to storage.
 */
export async function putPublishedArtifact(params: {
  subdomain: string;
  path: string;
  html: string;
}): Promise<{ key: string }> {
  const key = buildPublishedKey(params.subdomain, params.path);

  await getS3Client().send(
    new PutObjectCommand({
      Bucket: getS3Bucket(),
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
  await getS3Client().send(
    new DeleteObjectCommand({
      Bucket: getS3Bucket(),
      Key: key,
    }),
  );
}
