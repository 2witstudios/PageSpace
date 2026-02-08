import type { NextFunction, Request, Response } from 'express';
import { sessionService, type SessionClaims } from '@pagespace/lib/auth';
import { EnforcedAuthContext } from '@pagespace/lib/permissions';
import { loggers } from '@pagespace/lib/logger-config';

/**
 * Authentication is ALWAYS required in production.
 * In development only, it can be explicitly disabled with PROCESSOR_AUTH_REQUIRED=false.
 */
export const AUTH_REQUIRED = (() => {
  const wantsDisabled = process.env.PROCESSOR_AUTH_REQUIRED === 'false';
  const isDevelopment = process.env.NODE_ENV === 'development';

  if (wantsDisabled && !isDevelopment) {
    throw new Error(
      'PROCESSOR_AUTH_REQUIRED=false is only allowed in development mode. ' +
      'Authentication cannot be disabled in production.'
    );
  }

  return !wantsDisabled;
})();

function respondUnauthorized(res: Response, message = 'Authentication required'): void {
  res.status(401).json({ error: message });
}

function respondForbidden(res: Response, message: string, scope?: string): void {
  res.status(403).json({
    error: message,
    ...(scope ? { requiredScope: scope } : {}),
  });
}

export async function authenticateService(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!AUTH_REQUIRED) {
    next();
    return;
  }

  const header = req.headers.authorization;
  const requestContext = {
    endpoint: req.path,
    method: req.method,
    ip: req.ip || req.socket?.remoteAddress,
    userAgent: req.headers['user-agent']?.substring(0, 100),
  };

  if (!header || !header.startsWith('Bearer ')) {
    loggers.security.warn('Processor auth: missing or invalid authorization header', requestContext);
    respondUnauthorized(res);
    return;
  }

  const token = header.slice(7).trim();
  const tokenPrefix = token.substring(0, 12); // Log prefix only for debugging

  try {
    const claims = await sessionService.validateSession(token);

    if (!claims) {
      loggers.security.warn('Processor auth: invalid or expired token', {
        ...requestContext,
        tokenPrefix,
      });
      respondUnauthorized(res, 'Invalid or expired token');
      return;
    }

    // Reject non-service session types - processor is for service-to-service only
    if (claims.type !== 'service') {
      loggers.security.warn('Processor auth: non-service token rejected', {
        ...requestContext,
        tokenPrefix,
        tokenType: claims.type,
        userId: claims.userId,
      });
      respondForbidden(res, 'Service token required');
      return;
    }

    // Build enforced auth context from validated session
    // Scope checking is done by requireScope() middleware on each route
    const context = EnforcedAuthContext.fromSession(claims);
    req.auth = context;

    // Log successful service token validation for audit trail
    loggers.security.info('Processor auth: service token validated', {
      ...requestContext,
      userId: claims.userId,
      sessionId: claims.sessionId,
      scopes: claims.scopes,
      resourceType: claims.resourceType,
      resourceId: claims.resourceId,
      driveId: claims.driveId,
    });

    next();
  } catch (error) {
    loggers.security.error(
      'Processor auth: validation error',
      error instanceof Error ? error : new Error(String(error)),
      {
        ...requestContext,
        tokenPrefix,
      }
    );
    respondUnauthorized(res, 'Invalid token');
  }
}

export function requireScope(scope: string) {
  return function permissionMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (!AUTH_REQUIRED) {
      next();
      return;
    }

    const auth = req.auth;
    if (!auth) {
      respondUnauthorized(res);
      return;
    }

    if (!auth.hasScope(scope)) {
      loggers.security.warn('Processor auth: scope assertion failed', {
        required: scope,
        userId: auth.userId,
        endpoint: req.path,
        method: req.method,
        ip: req.ip || req.socket?.remoteAddress,
      });
      respondForbidden(res, `Missing required scope: ${scope}`, scope);
      return;
    }

    next();
  };
}

export function hasAuthScope(auth: EnforcedAuthContext | undefined, scope: string): boolean {
  if (!auth) {
    return false;
  }
  return auth.hasScope(scope);
}

export function getUserId(req: Request): string | null {
  const auth = req.auth;
  if (!auth) {
    return null;
  }
  return auth.userId;
}

export { EnforcedAuthContext };
