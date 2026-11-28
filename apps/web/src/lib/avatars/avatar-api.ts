import { fetchWithAuth, ApiRequestError } from '@/lib/auth/auth-fetch';

/**
 * POSTs an image to an avatar route (an org's or a drive's). Its refusals are written for people
 * (type, size), so they surface as ApiRequestError with the route's own message.
 */
export async function uploadAvatar<T>(path: string, file: File): Promise<T> {
  const body = new FormData();
  body.append('file', file);
  const response = await fetchWithAuth(path, { method: 'POST', body });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : 'The image could not be uploaded.';
    throw new ApiRequestError(message, response.status, data ?? undefined);
  }
  return data as T;
}
