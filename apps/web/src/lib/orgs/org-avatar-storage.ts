/**
 * ORG-1: the org avatar file lives in PageSpace storage, written by the processor. Every call
 * carries a service token BOUND to the org, minted only for its Owner and Admins
 * (createOrgServiceToken); the processor refuses any other binding.
 */
import { createOrgServiceToken } from '@pagespace/lib/services/validated-service-token';

const PROCESSOR_URL = process.env.PROCESSOR_URL || 'http://processor:3003';

/** Minted while the caller still holds the org (an org delete mints it before the org is gone). */
export async function mintOrgAvatarToken(orgId: string, userId: string): Promise<string> {
  const { token } = await createOrgServiceToken(userId, orgId, ['org-avatars:write'], '5m');
  return token;
}

export function callOrgAvatarStorage(
  orgId: string,
  token: string,
  init: { method: 'POST' | 'DELETE'; body?: FormData },
): Promise<Response> {
  return fetch(`${PROCESSOR_URL}/api/org-avatar/${encodeURIComponent(orgId)}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}` },
    // Bounded so a stalled processor can't pin this request slot open.
    signal: AbortSignal.timeout(60_000),
  });
}
