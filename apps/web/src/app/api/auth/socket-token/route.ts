import { requireAuth, isAuthError } from '@/lib/auth/auth-helpers';
import { db, socketTokens } from '@pagespace/db';
import { randomBytes, createHash } from 'crypto';

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
 * 3. Server creates short-lived socket token (5 min)
 * 4. Client passes token to Socket.IO auth.token
 */
export async function GET(request: Request) {
  // Validate user via httpOnly cookie (same-origin request)
  const auth = await requireAuth(request);
  if (isAuthError(auth)) return auth;

  // Generate short-lived socket token (5 minutes)
  const tokenValue = `ps_sock_${randomBytes(24).toString('base64url')}`;
  const tokenHash = createHash('sha256').update(tokenValue).digest('hex');
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

  // Store hash in database (never store plaintext)
  await db.insert(socketTokens).values({
    tokenHash,
    userId: auth.userId,
    expiresAt,
  });

  // Return with no-cache headers to prevent token reuse across sessions
  return Response.json({
    token: tokenValue,
    expiresAt: expiresAt.toISOString(),
  }, {
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Vary': 'Cookie',
    },
  });
}
