/**
 * The drive avatar file lives in PageSpace storage, written by the processor. Every call carries a
 * service token BOUND to the drive, minted only for its Owner and Admins (createDriveServiceToken
 * with drive-avatars:write); the processor refuses any other binding.
 */
import { createDriveServiceToken } from '@pagespace/lib/services/validated-service-token';
import type { AccessActor } from '@pagespace/lib/permissions/access-actor';
import { callAvatarStorage, type AvatarStorageRequest } from '@/lib/avatars/avatar-storage';

export async function mintDriveAvatarToken(driveId: string, actor: AccessActor): Promise<string> {
  const { token } = await createDriveServiceToken(actor, driveId, ['drive-avatars:write'], '5m');
  return token;
}

/** The drive subject of callAvatarStorage. */
export function callDriveAvatarStorage(driveId: string, token: string, init: AvatarStorageRequest): Promise<Response> {
  return callAvatarStorage('drive', driveId, token, init);
}
