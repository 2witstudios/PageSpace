import { NextResponse } from 'next/server';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { isOrgAvatarFilename, orgAvatarStorageKey } from '@pagespace/lib/organizations/org-avatar-core';
import { apiError } from '@/lib/api/api-error';
import { getS3Client, getS3Bucket } from '@/lib/presigned-url';
import { authorizeOrgRequest, ORG_READ_AUTH } from '@/lib/orgs/org-route-auth';

const CONTENT_TYPES: Readonly<Record<string, string>> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

const isNotFound = (err: unknown): boolean =>
  !!err && typeof err === 'object' && ('$metadata' in err
    ? (err as { $metadata: { httpStatusCode?: number } }).$metadata.httpStatusCode === 404
    : (err as { name?: string }).name === 'NoSuchKey');

/**
 * GET /api/orgs/[orgId]/avatar/[filename] — the org's avatar image (ORG-1), for its members only:
 * whether an org exists is org data, so an outsider gets the same 404 as for any org route.
 */
export async function GET(request: Request, context: { params: Promise<{ orgId: string; filename: string }> }) {
  const { orgId, filename } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'MEMBER', ORG_READ_AUTH);
  if (!gate.ok) return gate.response;
  if (!isOrgAvatarFilename(filename)) return apiError(400, 'invalid_request', 'Not an organization avatar');

  const key = orgAvatarStorageKey(orgId, filename);
  try {
    const object = await getS3Client().send(new GetObjectCommand({ Bucket: getS3Bucket(), Key: key }));
    if (!object.Body) return new NextResponse('Not Found', { status: 404 });
    const bytes = await object.Body.transformToByteArray();
    return new NextResponse(bytes, {
      status: 200,
      headers: {
        'Content-Type': CONTENT_TYPES[filename.split('.').pop() ?? ''] ?? 'application/octet-stream',
        // Members only, so never a shared cache; the stored path is versioned, so the browser may keep it.
        'Cache-Control': 'private, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (err) {
    if (!isNotFound(err)) loggers.api.warn('Org avatar read error', { key, err: String(err) });
    return new NextResponse('Not Found', { status: 404 });
  }
}
