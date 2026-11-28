// The short-lived credential imago's socket authenticates with.
//
// The session cookie is httpOnly and SameSite=strict, so it never reaches
// realtime on its own origin. apps/web trades it, same-origin, for a 5-minute
// `ps_sock_` session (apps/web/src/app/api/auth/socket-token/route.ts) that
// realtime validates at the handshake. Only that token ever goes into the
// socket's auth; nothing long-lived does.

import type { ApiClient } from '@/api/client';
import { ApiError, INVALID_RESPONSE } from '@/api/errors';

/** apps/web's socket token route. */
export const SOCKET_TOKEN_ENDPOINT = '/api/auth/socket-token';

/** Prefix of the socket-type session realtime accepts (apps/realtime/src/index.ts). */
const SOCKET_TOKEN_PREFIX = 'ps_sock_';

const tokenOf = (body: unknown): string | null => {
  if (typeof body !== 'object' || body === null || !('token' in body)) return null;
  const { token } = body;
  return typeof token === 'string' && token.startsWith(SOCKET_TOKEN_PREFIX) ? token : null;
};

/**
 * Mints a new socket token; every call asks apps/web again, nothing is cached.
 * Rejects with ApiError like any imago API call (a 401 has already sent the
 * page to sign-in), or with INVALID_RESPONSE when the answer is not a
 * `ps_sock_` token.
 */
export async function fetchSocketToken(client: ApiClient): Promise<string> {
  const body = await client.apiFetch<unknown>(SOCKET_TOKEN_ENDPOINT);
  const token = tokenOf(body);
  if (!token) {
    throw new ApiError({
      status: 200,
      code: INVALID_RESPONSE,
      message: 'Socket token response carried no ps_sock_ token',
    });
  }
  return token;
}
