import type { NextFunction, Request, Response } from 'express';
import { sessionService, type SessionClaims } from '@pagespace/lib/auth';
import { EnforcedAuthContext } from '@pagespace/lib/permissions';

export const AUTH_REQUIRED = process.env.PROCESSOR_AUTH_REQUIRED !== 'false';

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
  if (!header || !header.startsWith('Bearer ')) {
    respondUnauthorized(res);
    return;
  }

  const token = header.slice(7).trim();

  try {
    const claims = await sessionService.validateSession(token);

    if (!claims) {
      respondUnauthorized(res, 'Invalid or expired token');
      return;
    }

    // Reject non-service session types - processor is for service-to-service only
    if (claims.type !== 'service') {
      respondForbidden(res, 'Service token required');
      return;
    }

    // Build enforced auth context from validated session
    // Scope checking is done by requireScope() middleware on each route
    const context = EnforcedAuthContext.fromSession(claims);
    req.auth = context;

    next();
  } catch (error) {
    console.error('Authentication failed:', error);
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
      if (process.env.NODE_ENV !== 'test') {
        console.warn('Scope assertion failed', {
          required: scope,
          userId: auth.userId,
          path: req.path,
        });
      }
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
