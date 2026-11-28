import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { avatarFilenameFromPath, avatarPath } from '@pagespace/lib/avatars/avatar-core';
import { setDriveAvatar, type SetDriveAvatarResult } from '@pagespace/lib/services/drive-service';
import { getDriveRecipientUserIds } from '@pagespace/lib/services/drive-member-service';
import { authenticateRequestWithOptions, isAuthError, isPrincipalDriveOwnerOrAdmin } from '@/lib/auth';
import { actorFromAuth, deniedResponse } from '@/lib/auth/request-actor';
import { broadcastDriveEvent, createDriveEventPayload } from '@/lib/websocket';
import { apiError } from '@/lib/api/api-error';
import { callDriveAvatarStorage, mintDriveAvatarToken } from '@/lib/drives/drive-avatar-storage';
import type { AvatarStorageCall } from '@/lib/avatars/avatar-storage';
import { readAvatarUpload, removeAvatarFile, storeAvatarFile } from '@/lib/avatars/avatar-route';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

type Context = { params: Promise<{ driveId: string }> };

const storageFor = (driveId: string, token: string): AvatarStorageCall => (init) => callDriveAvatarStorage(driveId, token, init);
type Gate = { ok: true; userId: string; actor: ReturnType<typeof actorFromAuth> } | { ok: false; response: NextResponse };

/** A drive Owner or Admin, the same authority as every other drive setting (PATCH /api/drives/[driveId]). */
async function authorize(request: Request, driveId: string): Promise<Gate> {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) return { ok: false, response: auth.error };
  if (!(await isPrincipalDriveOwnerOrAdmin(auth, driveId))) {
    return {
      ok: false,
      response: await deniedResponse(actorFromAuth(auth), driveId, NextResponse.json(
        { error: 'Only drive owners and admins can change the drive avatar' },
        { status: 403 },
      )),
    };
  }
  return { ok: true, userId: auth.userId, actor: actorFromAuth(auth) };
}

function avatarWriteRefusal(result: Extract<SetDriveAvatarResult, { ok: false }>) {
  if (result.reason === 'invalid_avatar') return apiError(400, 'invalid_request', 'Invalid drive avatar');
  return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
}

/** Everyone who lists the drive refetches it, so its mark follows without a refresh. */
async function announce(drive: { id: string; name: string; slug: string }): Promise<void> {
  const recipientUserIds = await getDriveRecipientUserIds(drive.id);
  await broadcastDriveEvent(createDriveEventPayload(drive.id, 'updated', { name: drive.name, slug: drive.slug }), recipientUserIds);
}

/**
 * POST /api/drives/[driveId]/avatar — upload the drive's avatar; Owner and Admins. The image is
 * stored by PageSpace and served from /api/drives/[driveId]/avatar/[filename]; a drive avatar is
 * never a URL on another host. The same order as the org avatar (lib/avatars/avatar-route.ts):
 * write the new file, switch the drive to it, then delete the file it replaced.
 */
export async function POST(request: Request, context: Context) {
  const { driveId } = await context.params;
  const gate = await authorize(request, driveId);
  if (!gate.ok) return gate.response;
  try {
    const upload = await readAvatarUpload(request);
    if (!upload.ok) return upload.response;
    const token = await mintDriveAvatarToken(driveId, gate.actor);
    const filename = await storeAvatarFile('drive', driveId, storageFor(driveId, token), upload.file);
    if (!filename) return apiError(502, 'internal_error', 'Could not store the image');

    const saved = await setDriveAvatar(driveId, avatarPath('drive', driveId, filename));
    if (!saved.ok) {
      // Nothing points at the new file: remove it.
      await removeAvatarFile('drive', driveId, storageFor(driveId, token), filename);
      return avatarWriteRefusal(saved);
    }
    await removeAvatarFile('drive', driveId, storageFor(driveId, token), saved.previousAvatarUrl && avatarFilenameFromPath('drive', driveId, saved.previousAvatarUrl));
    auditRequest(request, {
      eventType: 'data.write',
      userId: gate.userId,
      resourceType: 'drive',
      resourceId: driveId,
      details: { operation: 'upload_drive_avatar' },
    });
    await announce(saved.drive);
    return NextResponse.json({ drive: { id: saved.drive.id, avatarUrl: saved.drive.avatarUrl } });
  } catch (error) {
    loggers.api.error('Error uploading drive avatar:', error as Error);
    return apiError(500, 'internal_error', 'Failed to upload the avatar');
  }
}

/** DELETE /api/drives/[driveId]/avatar — clear the drive's avatar, then remove the file it pointed to; Owner and Admins. */
export async function DELETE(request: Request, context: Context) {
  const { driveId } = await context.params;
  const gate = await authorize(request, driveId);
  if (!gate.ok) return gate.response;
  try {
    const token = await mintDriveAvatarToken(driveId, gate.actor);
    const saved = await setDriveAvatar(driveId, null);
    if (!saved.ok) return avatarWriteRefusal(saved);
    await removeAvatarFile('drive', driveId, storageFor(driveId, token), saved.previousAvatarUrl && avatarFilenameFromPath('drive', driveId, saved.previousAvatarUrl));
    auditRequest(request, {
      eventType: 'data.delete',
      userId: gate.userId,
      resourceType: 'drive',
      resourceId: driveId,
      details: { operation: 'delete_drive_avatar' },
    });
    await announce(saved.drive);
    return NextResponse.json({ drive: { id: saved.drive.id, avatarUrl: saved.drive.avatarUrl } });
  } catch (error) {
    loggers.api.error('Error removing drive avatar:', error as Error);
    return apiError(500, 'internal_error', 'Failed to remove the avatar');
  }
}
