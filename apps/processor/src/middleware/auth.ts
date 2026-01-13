import type { NextFunction, Request, Response } from 'express';
import { sessionService, type SessionClaims } from '@pagespace/lib/auth';
import { EnforcedAuthContext } from '@pagespace/lib/permissions';

export const AUTH_REQUIRED = process.env.PROCESSOR_AUTH_REQUIRED !== 'false';

function collectCandidateUrls(req: Request): string[] {
  const rawValues: Array<string | undefined | null> = [
    req.baseUrl,
    req.originalUrl,
    req.path,
    (req as any).url,
  ];

  const queryParamUrls: string[] = [];
  const hasAvatarQuery = req.originalUrl?.includes('/api/avatar/upload');
  if (hasAvatarQuery) {
    queryParamUrls.push('/api/avatar/upload');
    queryParamUrls.push('api/avatar/upload');
  }

  return [...rawValues, ...queryParamUrls]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map((value) => value.toLowerCase());
}

function inferScope(req: Request): string | null {
  const method = req.method.toUpperCase();
  const candidateUrls = collectCandidateUrls(req);

  const originalUrl = req.originalUrl?.toLowerCase() ?? '';
  if (originalUrl.includes('/api/avatar/')) {
    return 'avatars:write';
  }

  const matches = (url: string, prefix: string) =>
    url === prefix || url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`);

  for (const url of candidateUrls) {
    if (matches(url, '/api/avatar') || matches(url, 'api/avatar') || matches(url, '/avatar')) {
      return 'avatars:write';
    }
  }

  for (const url of candidateUrls) {
    if (matches(url, '/api/upload') || matches(url, 'api/upload')) {
      return 'files:write';
    }
  }

  for (const url of candidateUrls) {
    if (matches(url, '/api/optimize') || matches(url, 'api/optimize')) {
      return method === 'GET' ? 'files:read' : 'files:optimize';
    }
  }

  for (const url of candidateUrls) {
    if (matches(url, '/api/ingest') || matches(url, 'api/ingest')) {
      return 'files:ingest';
    }
  }

  for (const url of candidateUrls) {
    if (matches(url, '/cache') || matches(url, 'cache')) {
      return 'files:read';
    }
  }

  for (const url of candidateUrls) {
    if (matches(url, '/api/queue') || matches(url, 'api/queue') || matches(url, '/api/job') || matches(url, 'api/job')) {
      return 'queue:read';
    }
  }

  return null;
}

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
    const context = EnforcedAuthContext.fromSession(claims);
    req.auth = context;

    // Check inferred scope if applicable
    const inferredScope = inferScope(req);
    if (inferredScope && !context.hasScope(inferredScope)) {
      if (process.env.NODE_ENV !== 'test') {
        console.warn('Scope inference failed', {
          required: inferredScope,
          userId: claims.userId,
          resourceBinding: context.resourceBinding,
          urls: collectCandidateUrls(req),
        });
      }
      respondForbidden(res, 'Insufficient scopes', inferredScope);
      return;
    }

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
          urls: collectCandidateUrls(req),
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
