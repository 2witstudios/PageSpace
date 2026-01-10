import type { NextFunction, Request, Response } from 'express';
import {
  authenticateServiceToken,
  assertScope as assertServiceScope,
  hasScope,
  type ServiceScope,
  type ServiceTokenClaims,
} from '@pagespace/lib';
import { validateServiceUser } from '../services/user-validator';

export interface ProcessorServiceAuth {
  userId: string;
  service: string;
  scopes: ServiceScope[];
  claims: ServiceTokenClaims;
  resource?: string;
  driveId?: string;
  /**
   * Compatibility shim for legacy code paths that still expect tenantId === userId
   * or the resource identifier. This should be removed when RBAC integration is complete.
   */
  tenantId?: string;
}

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

function inferScope(req: Request): ServiceScope | null {
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

function buildAuthContext(claims: ServiceTokenClaims): ProcessorServiceAuth {
  const scopes = Array.isArray(claims.scopes) ? (claims.scopes as ServiceScope[]) : [];
  const userId = String(claims.sub);

  return {
    userId,
    service: claims.service,
    scopes,
    claims,
    resource: claims.resource,
    driveId: claims.driveId,
    tenantId: claims.resource ?? userId,
  };
}

function respondUnauthorized(res: Response, message = 'Service authentication required'): void {
  res.status(401).json({ error: message });
}

function respondForbidden(res: Response, message: string, scope?: ServiceScope): void {
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
    const { claims } = await authenticateServiceToken(token);

    if (!claims.service || typeof claims.service !== 'string') {
      respondForbidden(res, 'Service token missing service identifier');
      return;
    }

    if (!claims.scopes || !Array.isArray(claims.scopes) || claims.scopes.length === 0) {
      respondForbidden(res, 'Service token missing scopes');
      return;
    }

    // P1-T2: Validate that the user still exists
    const userValidation = await validateServiceUser(String(claims.sub));

    if (!userValidation.valid) {
      if (process.env.NODE_ENV !== 'test') {
        console.warn('Service token user validation failed', {
          service: claims.service,
          subject: claims.sub,
          reason: userValidation.reason,
        });
      }
      respondUnauthorized(res, `User validation failed: ${userValidation.reason}`);
      return;
    }

    const context = buildAuthContext(claims);
    req.serviceAuth = context;

    const inferredScope = inferScope(req);
    if (inferredScope && !hasScope(claims, inferredScope)) {
      if (process.env.NODE_ENV !== 'test') {
        console.warn('Service scope inference failed', {
          service: claims.service,
          required: inferredScope,
          provided: claims.scopes,
          subject: claims.sub,
          resource: claims.resource,
          urls: collectCandidateUrls(req),
        });
      }
      respondForbidden(res, 'Insufficient service scopes', inferredScope);
      return;
    }

    next();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid service token';
    console.error('Service authentication failed:', message);
    respondUnauthorized(res, 'Invalid service token');
  }
}

export function requireScope(scope: ServiceScope) {
  return function permissionMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (!AUTH_REQUIRED) {
      next();
      return;
    }

    const auth = req.serviceAuth;
    if (!auth) {
      respondUnauthorized(res);
      return;
    }

    try {
      assertServiceScope(auth.claims, scope);
      next();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Insufficient service scopes';
      if (process.env.NODE_ENV !== 'test') {
        console.warn('Service scope assertion failed', {
          service: auth.service,
          required: scope,
          provided: auth.scopes,
          subject: auth.userId,
          resource: auth.resource,
          urls: collectCandidateUrls(req),
        });
      }
      respondForbidden(res, message, scope);
    }
  };
}

export function hasServiceScope(auth: ProcessorServiceAuth | undefined, scope: ServiceScope): boolean {
  if (!auth) {
    return false;
  }
  return hasScope(auth.claims, scope);
}

export function requireTenantContext(req: Request): string | null {
  const auth = req.serviceAuth;
  if (!auth) {
    return null;
  }

  const tokenTenant = auth.tenantId ?? null;
  const bodyTenant = typeof req.body?.tenantId === 'string' ? req.body.tenantId : null;

  if (!tokenTenant) {
    return bodyTenant;
  }

  if (bodyTenant && bodyTenant !== tokenTenant) {
    return null;
  }

  if (!bodyTenant && typeof req.body === 'object' && req.body !== null) {
    (req.body as Record<string, unknown>).tenantId = tokenTenant;
  }

  return tokenTenant;
}

export type { ServiceScope };
