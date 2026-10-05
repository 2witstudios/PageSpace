import 'server-only';
import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { sessionService } from '@pagespace/lib/auth/session-service';
import {
  PATHNAME_HEADER,
  SESSION_COOKIE,
  requestOrigin,
  signInLocation,
  signInOrigin,
} from './sign-in-url';

export type Viewer = {
  userId: string;
  role: 'user' | 'admin';
  sessionId: string;
};

/**
 * The signed-in viewer for this request, or a redirect to classic's sign-in.
 *
 * Middleware only checks that a session cookie is present (the edge cannot
 * reach the database); this validates it. Only a browser session counts: a
 * socket, service, MCP or device token replayed into the cookie is rejected,
 * as are expired and revoked sessions. Cached per request, so every server
 * component can call it without another database round trip.
 */
export const getViewer = cache(async (): Promise<Viewer> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const claims = token
    ? await sessionService.validateSession(token, { expectedType: 'user' })
    : null;

  if (claims) {
    return { userId: claims.userId, role: claims.userRole, sessionId: claims.sessionId };
  }

  const requestHeaders = await headers();
  redirect(
    signInLocation({
      origin: signInOrigin(requestOrigin(requestHeaders)),
      pathname: requestHeaders.get(PATHNAME_HEADER),
    }),
  );
});
