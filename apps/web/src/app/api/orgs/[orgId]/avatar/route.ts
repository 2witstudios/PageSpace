import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { setOrganizationAvatar, type SetOrganizationAvatarResult } from '@pagespace/lib/organizations/repository';
import { announceOrgChange } from '@pagespace/lib/organizations/org-change-events';
import { orgAvatarFilenameFromPath, orgAvatarPath } from '@pagespace/lib/organizations/org-avatar-core';
import { apiError } from '@/lib/api/api-error';
import { authorizeOrgRequest, ORG_SESSION_WRITE_AUTH } from '@/lib/orgs/org-route-auth';
import { callOrgAvatarStorage, mintOrgAvatarToken } from '@/lib/orgs/org-avatar-storage';
import type { AvatarStorageCall } from '@/lib/avatars/avatar-storage';
import { readAvatarUpload, removeAvatarFile, storeAvatarFile } from '@/lib/avatars/avatar-route';

type Context = { params: Promise<{ orgId: string }> };

const storageFor = (orgId: string, token: string): AvatarStorageCall => (init) => callOrgAvatarStorage(orgId, token, init);

function avatarResponse(organization: { id: string; avatarUrl: string | null }) {
  return NextResponse.json({ organization: { id: organization.id, avatarUrl: organization.avatarUrl } });
}

function avatarWriteRefusal(result: Extract<SetOrganizationAvatarResult, { ok: false }>) {
  if (result.reason === 'insufficient_role') return apiError(403, 'insufficient_role', 'Only an Owner or Admin can change the organization avatar');
  if (result.reason === 'not_member') return apiError(404, 'not_member', 'Organization not found');
  if (result.reason === 'invalid_avatar') return apiError(400, 'invalid_request', 'Invalid organization avatar');
  return apiError(404, 'org_not_found', 'Organization not found');
}

/**
 * POST /api/orgs/[orgId]/avatar — upload the org's avatar (ORG-1); Owner and Admins. The image is
 * stored by PageSpace and served from /api/orgs/[orgId]/avatar/[filename]; an org avatar is never
 * a URL on another host. Order (review of #2869): write the new file, switch the org to it, then
 * delete the file it replaced, so the stored path always names a file that exists, and concurrent
 * uploads each delete only the file their switch replaced (setOrganizationAvatar locks the row).
 */
export async function POST(request: Request, context: Context) {
  const { orgId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'ADMIN', ORG_SESSION_WRITE_AUTH);
  if (!gate.ok) return gate.response;
  try {
    const upload = await readAvatarUpload(request);
    if (!upload.ok) return upload.response;
    const token = await mintOrgAvatarToken(orgId, gate.actor);
    const filename = await storeAvatarFile('org', orgId, storageFor(orgId, token), upload.file);
    if (!filename) return apiError(502, 'internal_error', 'Could not store the image');

    const saved = await setOrganizationAvatar(orgId, orgAvatarPath(orgId, filename), gate.userId);
    if (!saved.ok) {
      // Nothing points at the new file: remove it.
      await removeAvatarFile('org', orgId, storageFor(orgId, token), filename);
      return avatarWriteRefusal(saved);
    }
    await removeAvatarFile('org', orgId, storageFor(orgId, token), saved.previousAvatarUrl && orgAvatarFilenameFromPath(orgId, saved.previousAvatarUrl));
    auditRequest(request, {
      eventType: 'data.write',
      userId: gate.userId,
      resourceType: 'organization',
      resourceId: orgId,
      details: { operation: 'upload_org_avatar' },
    });
    // X-4: the org mark in the picker and the crumb follows without a refresh.
    void announceOrgChange(orgId, 'profile');
    return avatarResponse(saved.organization);
  } catch (error) {
    loggers.api.error('Error uploading organization avatar:', error as Error);
    return apiError(500, 'internal_error', 'Failed to upload the avatar');
  }
}

/** DELETE /api/orgs/[orgId]/avatar — clear the org's avatar, then remove the file it pointed to; Owner and Admins. */
export async function DELETE(request: Request, context: Context) {
  const { orgId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'ADMIN', ORG_SESSION_WRITE_AUTH);
  if (!gate.ok) return gate.response;
  try {
    const token = await mintOrgAvatarToken(orgId, gate.actor);
    const saved = await setOrganizationAvatar(orgId, null, gate.userId);
    if (!saved.ok) return avatarWriteRefusal(saved);
    await removeAvatarFile('org', orgId, storageFor(orgId, token), saved.previousAvatarUrl && orgAvatarFilenameFromPath(orgId, saved.previousAvatarUrl));
    auditRequest(request, {
      eventType: 'data.delete',
      userId: gate.userId,
      resourceType: 'organization',
      resourceId: orgId,
      details: { operation: 'delete_org_avatar' },
    });
    // X-4: the org mark in the picker and the crumb follows without a refresh.
    void announceOrgChange(orgId, 'profile');
    return avatarResponse(saved.organization);
  } catch (error) {
    loggers.api.error('Error removing organization avatar:', error as Error);
    return apiError(500, 'internal_error', 'Failed to remove the avatar');
  }
}
