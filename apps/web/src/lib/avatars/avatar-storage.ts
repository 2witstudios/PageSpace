/**
 * An org's or a drive's avatar file lives in PageSpace storage, written by the processor
 * (apps/processor/src/api/subject-avatar.ts). Every call carries a service token BOUND to that org
 * or drive, minted only for its Owner and Admins; the processor refuses any other binding.
 */
import type { AvatarSubject } from '@pagespace/lib/avatars/avatar-core';

const PROCESSOR_URL = process.env.PROCESSOR_URL || 'http://processor:3003';

const ENDPOINTS: Readonly<Record<AvatarSubject, string>> = { org: 'org-avatar', drive: 'drive-avatar' };

export type AvatarStorageRequest = { method: 'POST' | 'DELETE'; body?: FormData; filename?: string };

/** One subject's storage, bound to its id and token: what the shared avatar route steps call. */
export type AvatarStorageCall = (init: AvatarStorageRequest) => Promise<Response>;

/**
 * POST writes a new file (the answer names it); DELETE with a filename removes that one file; DELETE
 * without one empties the subject's folder (only when the org or drive itself is deleted).
 */
export function callAvatarStorage(
  subject: AvatarSubject,
  id: string,
  token: string,
  init: AvatarStorageRequest,
): Promise<Response> {
  const { filename, ...request } = init;
  const file = filename ? `/${encodeURIComponent(filename)}` : '';
  return fetch(`${PROCESSOR_URL}/api/${ENDPOINTS[subject]}/${encodeURIComponent(id)}${file}`, {
    ...request,
    headers: { Authorization: `Bearer ${token}` },
    // Bounded so a stalled processor can't pin this request slot open.
    signal: AbortSignal.timeout(60_000),
  });
}
