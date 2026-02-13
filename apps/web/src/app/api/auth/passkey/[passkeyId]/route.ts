import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { deletePasskey, updatePasskeyName, validateCSRFToken } from '@pagespace/lib/auth';
import { loggers } from '@pagespace/lib/server';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';
import {
  authenticateSessionRequest,
  isAuthError,
  isSessionAuthResult,
  getClientIP,
} from '@/lib/auth';

const updateNameSchema = z.object({
  name: z.string().min(1).max(255),
});

/**
 * DELETE /api/auth/passkey/[passkeyId]
 *
 * Delete a passkey owned by the authenticated user.
 * Requires session authentication and CSRF token.
 */
export async function DELETE(
  req: Request,
  context: { params: Promise<{ passkeyId: string }> }
) {
  try {
    const { passkeyId } = await context.params;
    const clientIP = getClientIP(req);

    // Verify session auth
    const authResult = await authenticateSessionRequest(req);
    if (isAuthError(authResult)) {
      return authResult.error;
    }

    const userId = authResult.userId;
    const sessionId = isSessionAuthResult(authResult) ? authResult.sessionId : null;

    // Verify CSRF token (skip for Bearer token auth - not vulnerable to CSRF)
    const hasBearerAuth = !!req.headers.get('authorization');
    if (!hasBearerAuth && sessionId) {
      const csrfToken = req.headers.get('x-csrf-token');
      if (!csrfToken || !validateCSRFToken(csrfToken, sessionId)) {
        loggers.auth.warn('CSRF validation failed for passkey deletion', {
          userId,
          passkeyId,
          ip: clientIP,
        });
        return NextResponse.json(
          { error: 'Invalid CSRF token' },
          { status: 403 }
        );
      }
    }

    // Delete passkey
    const result = await deletePasskey({ userId, passkeyId });

    if (!result.ok) {
      if (result.error.code === 'PASSKEY_NOT_FOUND') {
        return NextResponse.json(
          { error: 'Passkey not found' },
          { status: 404 }
        );
      }

      loggers.auth.warn('Failed to delete passkey', {
        userId,
        passkeyId,
        error: result.error.code,
        ip: clientIP,
      });

      return NextResponse.json(
        { error: 'Failed to delete passkey' },
        { status: 500 }
      );
    }

    // Track passkey deletion
    trackAuthEvent(userId, 'passkey_deleted', {
      ip: clientIP,
      passkeyId,
      userAgent: req.headers.get('user-agent'),
    });

    loggers.auth.info('Passkey deleted', {
      userId,
      passkeyId,
      ip: clientIP,
    });

    return NextResponse.json({ success: true });

  } catch (error) {
    loggers.auth.error('Delete passkey error', error as Error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/auth/passkey/[passkeyId]
 *
 * Update passkey name.
 * Requires session authentication and CSRF token.
 */
export async function PATCH(
  req: Request,
  context: { params: Promise<{ passkeyId: string }> }
) {
  try {
    const { passkeyId } = await context.params;
    const clientIP = getClientIP(req);

    // Verify session auth
    const authResult = await authenticateSessionRequest(req);
    if (isAuthError(authResult)) {
      return authResult.error;
    }

    const userId = authResult.userId;
    const sessionId = isSessionAuthResult(authResult) ? authResult.sessionId : null;

    // Verify CSRF token (skip for Bearer token auth - not vulnerable to CSRF)
    const hasBearerAuth = !!req.headers.get('authorization');
    if (!hasBearerAuth && sessionId) {
      const csrfToken = req.headers.get('x-csrf-token');
      if (!csrfToken || !validateCSRFToken(csrfToken, sessionId)) {
        loggers.auth.warn('CSRF validation failed for passkey update', {
          userId,
          passkeyId,
          ip: clientIP,
        });
        return NextResponse.json(
          { error: 'Invalid CSRF token' },
          { status: 403 }
        );
      }
    }

    // Parse and validate request body
    const body = await req.json();
    const validation = updateNameSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: validation.error.issues },
        { status: 400 }
      );
    }

    const { name } = validation.data;

    // Update passkey name
    const result = await updatePasskeyName({ userId, passkeyId, name });

    if (!result.ok) {
      if (result.error.code === 'PASSKEY_NOT_FOUND') {
        return NextResponse.json(
          { error: 'Passkey not found' },
          { status: 404 }
        );
      }

      if (result.error.code === 'VALIDATION_FAILED') {
        return NextResponse.json(
          { error: 'Invalid name' },
          { status: 400 }
        );
      }

      loggers.auth.warn('Failed to update passkey name', {
        userId,
        passkeyId,
        error: result.error.code,
        ip: clientIP,
      });

      return NextResponse.json(
        { error: 'Failed to update passkey' },
        { status: 500 }
      );
    }

    loggers.auth.info('Passkey renamed', {
      userId,
      passkeyId,
      ip: clientIP,
    });

    return NextResponse.json({ success: true });

  } catch (error) {
    loggers.auth.error('Update passkey error', error as Error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
