import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { setOrganizationAvatar } from '@pagespace/lib/organizations/repository';
import {
  ORG_AVATAR_MAX_BYTES,
  ORG_AVATAR_MIME_TYPES,
  isOrgAvatarFilename,
  orgAvatarPath,
} from '@pagespace/lib/organizations/org-avatar-core';
import { apiError } from '@/lib/api/api-error';
import { authorizeOrgRequest, ORG_WRITE_AUTH } from '@/lib/orgs/org-route-auth';
import { callOrgAvatarStorage, mintOrgAvatarToken } from '@/lib/orgs/org-avatar-storage';

type Context = { params: Promise<{ orgId: string }> };

/** The processor writes the file; the token it gets is bound to this org and minted only for its Owner and Admins. */
const callProcessor = async (orgId: string, userId: string, init: { method: 'POST' | 'DELETE'; body?: FormData }) =>
  callOrgAvatarStorage(orgId, await mintOrgAvatarToken(orgId, userId), init);

function avatarResponse(organization: { id: string; avatarUrl: string | null }) {
  return NextResponse.json({ organization: { id: organization.id, avatarUrl: organization.avatarUrl } });
}

/**
 * POST /api/orgs/[orgId]/avatar — upload the org's avatar (ORG-1); Owner and Admins. The image is
 * stored by PageSpace and served from /api/orgs/[orgId]/avatar/[filename]; an org avatar is never
 * a URL on another host.
 */
export async function POST(request: Request, context: Context) {
  const { orgId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'ADMIN', ORG_WRITE_AUTH);
  if (!gate.ok) return gate.response;
  try {
    const form = await request.formData().catch(() => null);
    const file = form?.get('file');
    // A FormData entry is a string or a File; anything else (or nothing) is not an upload.
    if (!file || typeof file === 'string') return apiError(400, 'invalid_request', 'No image provided');
    if (!ORG_AVATAR_MIME_TYPES.includes(file.type)) {
      return apiError(400, 'invalid_request', 'Upload a JPEG, PNG, GIF or WebP image');
    }
    if (file.size > ORG_AVATAR_MAX_BYTES) return apiError(400, 'invalid_request', 'The image is larger than 5 MB');

    const body = new FormData();
    body.append('file', file);
    const stored = await callProcessor(orgId, gate.userId, { method: 'POST', body });
    const result: unknown = await stored.json().catch(() => null);
    const filename = result && typeof result === 'object' && 'filename' in result ? result.filename : null;
    // Zero trust at this boundary too: only an org avatar filename is ever recorded.
    if (!stored.ok || typeof filename !== 'string' || !isOrgAvatarFilename(filename)) {
      loggers.api.error('Org avatar upload rejected by storage', undefined, { orgId, status: stored.status });
      return apiError(502, 'internal_error', 'Could not store the image');
    }

    const saved = await setOrganizationAvatar(orgId, orgAvatarPath(orgId, filename, Date.now()), gate.userId);
    if (!saved.ok) return apiError(404, 'org_not_found', 'Organization not found');
    auditRequest(request, {
      eventType: 'data.write',
      userId: gate.userId,
      resourceType: 'organization',
      resourceId: orgId,
      details: { operation: 'upload_org_avatar' },
    });
    return avatarResponse(saved.organization);
  } catch (error) {
    loggers.api.error('Error uploading organization avatar:', error as Error);
    return apiError(500, 'internal_error', 'Failed to upload the avatar');
  }
}

/** DELETE /api/orgs/[orgId]/avatar — remove the org's avatar and its stored file; Owner and Admins. */
export async function DELETE(request: Request, context: Context) {
  const { orgId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'ADMIN', ORG_WRITE_AUTH);
  if (!gate.ok) return gate.response;
  try {
    const removed = await callProcessor(orgId, gate.userId, { method: 'DELETE' });
    if (!removed.ok) {
      loggers.api.error('Org avatar delete rejected by storage', undefined, { orgId, status: removed.status });
      return apiError(502, 'internal_error', 'Could not remove the image');
    }
    const saved = await setOrganizationAvatar(orgId, null, gate.userId);
    if (!saved.ok) return apiError(404, 'org_not_found', 'Organization not found');
    auditRequest(request, {
      eventType: 'data.delete',
      userId: gate.userId,
      resourceType: 'organization',
      resourceId: orgId,
      details: { operation: 'delete_org_avatar' },
    });
    return avatarResponse(saved.organization);
  } catch (error) {
    loggers.api.error('Error removing organization avatar:', error as Error);
    return apiError(500, 'internal_error', 'Failed to remove the avatar');
  }
}
