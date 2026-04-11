import { NextResponse } from 'next/server';
import { listUserPasskeys } from '@pagespace/lib/auth';
import { loggers, securityAudit } from '@pagespace/lib/server';
import {
  authenticateSessionRequest,
  isAuthError,
  getClientIP,
} from '@/lib/auth';

/**
 * GET /api/auth/passkey
 *
 * List all passkeys for the authenticated user.
 * Requires session authentication.
 */
export async function GET(req: Request) {
  try {
    const clientIP = getClientIP(req);

    // Verify session auth
    const authResult = await authenticateSessionRequest(req);
    if (isAuthError(authResult)) {
      return authResult.error;
    }

    const userId = authResult.userId;

    // List passkeys
    const result = await listUserPasskeys({ userId });

    if (!result.ok) {
      loggers.auth.warn('Failed to list passkeys', {
        userId,
        error: result.error.code,
        ip: clientIP,
      });

      return NextResponse.json(
        { error: 'Failed to list passkeys' },
        { status: 500 }
      );
    }

    securityAudit.logDataAccess(userId, 'read', 'passkey', userId).catch((error) => {
      loggers.security.warn('[PasskeyList] audit logDataAccess failed', { error: error instanceof Error ? error.message : String(error), userId });
    });

    return NextResponse.json({
      passkeys: result.data.passkeys,
    }, {
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    });

  } catch (error) {
    loggers.auth.error('List passkeys error', error as Error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
