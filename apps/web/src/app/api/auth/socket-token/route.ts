import { requireAuth, isAuthError } from '@/lib/auth/auth-helpers';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { sessionService } from '@pagespace/lib/auth/session-service';

const SOCKET_TOKEN_TTL_MS = 5 * 60 * 1000;

/**
 * Socket Token Endpoint (P2-T0 Hotfix)
 *
 * Creates short-lived tokens for Socket.IO authentication.
 * This bypasses the sameSite: 'strict' cookie restriction that prevents
 * httpOnly cookies from being sent to the cross-origin realtime service.
 *
 * Flow:
 * 1. Client calls this endpoint (same-origin, cookies sent)
 * 2. Server validates session via httpOnly cookie
 * 3. Server mints a short-lived (5 min) `ps_sock_*` session (type: 'socket')
 *    through the same unified opaque-token model every other token uses (#1054)
 * 4. Client passes token to Socket.IO auth.token
 */
export async function GET(request: Request) {
  // Validate user via httpOnly cookie (same-origin request)
  const auth = await requireAuth(request);
  if (isAuthError(auth)) return auth;

  const token = await sessionService.createSession({
    userId: auth.userId,
    type: 'socket',
    scopes: [],
    expiresInMs: SOCKET_TOKEN_TTL_MS,
  });
  const expiresAt = new Date(Date.now() + SOCKET_TOKEN_TTL_MS);

  auditRequest(request, { eventType: 'auth.token.created', userId: auth.userId, details: { tokenType: 'socket' } });

  // Return with no-cache headers to prevent token reuse across sessions
  return Response.json({
    token,
    expiresAt: expiresAt.toISOString(),
  }, {
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Vary': 'Cookie',
    },
  });
}
