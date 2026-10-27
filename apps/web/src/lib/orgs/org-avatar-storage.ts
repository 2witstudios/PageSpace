/**
 * ORG-1: the org avatar file lives in PageSpace storage, written by the processor. Every call
 * carries a service token BOUND to the org, minted only for its Owner and Admins
 * (createOrgServiceToken); the processor refuses any other binding.
 */
import { createOrgServiceToken } from '@pagespace/lib/services/validated-service-token';
import type { AccessActor } from '@pagespace/lib/permissions/access-actor';
import { callAvatarStorage, type AvatarStorageRequest } from '@/lib/avatars/avatar-storage';

/** Minted while the caller still holds the org (an org delete mints it before the org is gone). */
export async function mintOrgAvatarToken(orgId: string, actor: AccessActor): Promise<string> {
  const { token } = await createOrgServiceToken(actor, orgId, ['org-avatars:write'], '5m');
  return token;
}

/** The org subject of callAvatarStorage. */
export function callOrgAvatarStorage(
  orgId: string,
  token: string,
  init: AvatarStorageRequest,
): Promise<Response> {
  return callAvatarStorage('org', orgId, token, init);
}
