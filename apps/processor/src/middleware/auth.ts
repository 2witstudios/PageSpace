import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';

export interface ServiceTokenPayload extends jwt.JwtPayload {
  service: string;
  permissions: string[];
  tenantId?: string;
  userId?: string;
  driveIds?: string[];
}

export const AUTH_REQUIRED = process.env.PROCESSOR_AUTH_REQUIRED !== 'false';

function requireSecret(): string {
  const secret = process.env.SERVICE_JWT_SECRET;
  if (!secret) {
    throw new Error('SERVICE_JWT_SECRET is not configured for processor authentication');
  }
  return secret;
}

export function hasServicePermission(payload: ServiceTokenPayload, permission: string): boolean {
  const { permissions = [] } = payload;
  if (permissions.includes('*')) {
    return true;
  }

  if (permissions.includes(permission)) {
    return true;
  }

  const [scope] = permission.split(':');
  if (permissions.includes(`${scope}:*`)) {
    return true;
  }

  return false;
}

function inferPermission(req: Request): string | null {
  const baseUrl = req.baseUrl || '';
  const method = req.method.toUpperCase();

  if (baseUrl.startsWith('/api/upload')) {
    return 'files:write';
  }

  if (baseUrl.startsWith('/api/optimize')) {
    return method === 'GET' ? 'files:read' : 'files:optimize';
  }

  if (baseUrl.startsWith('/api/ingest')) {
    return 'files:ingest';
  }

  if (baseUrl.startsWith('/api/avatar')) {
    return 'avatars:write';
  }

  if (baseUrl.startsWith('/cache')) {
    return 'files:read';
  }

  if (baseUrl.startsWith('/api/queue') || baseUrl.startsWith('/api/job')) {
    return 'queue:read';
  }

  return null;
}

export function authenticateService(req: Request, res: Response, next: NextFunction): void {
  if (!AUTH_REQUIRED) {
    return next();
  }

  const header = req.headers.authorization;

  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Service authentication required' });
    return;
  }

  try {
    const token = header.slice(7).trim();
    const payload = jwt.verify(token, requireSecret()) as ServiceTokenPayload;

    if (!payload.service || !Array.isArray(payload.permissions)) {
      res.status(403).json({ error: 'Service token missing required claims' });
      return;
    }

    req.serviceAuth = payload;

    const inferredPermission = inferPermission(req);
    if (inferredPermission && !hasServicePermission(payload, inferredPermission)) {
      res.status(403).json({
        error: 'Insufficient service permissions',
        requiredPermission: inferredPermission
      });
      return;
    }

    next();
  } catch (error) {
    if (error instanceof Error) {
      console.error('Service authentication failed:', error.message);
    }
    res.status(401).json({ error: 'Invalid service token' });
  }
}

export function requirePermission(permission: string) {
  return function permissionMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (!AUTH_REQUIRED) {
      next();
      return;
    }

    if (!req.serviceAuth) {
      res.status(401).json({ error: 'Service authentication required' });
      return;
    }

    if (!hasServicePermission(req.serviceAuth, permission)) {
      res.status(403).json({
        error: 'Insufficient service permissions',
        requiredPermission: permission
      });
      return;
    }

    next();
  };
}

export function requireTenantContext(req: Request): string | null {
  if (!req.serviceAuth) {
    return null;
  }

  const tokenTenant = req.serviceAuth.tenantId ?? null;
  const bodyTenant = typeof req.body?.tenantId === 'string' ? req.body.tenantId : null;

  if (!tokenTenant) {
    return bodyTenant;
  }

  if (bodyTenant && bodyTenant !== tokenTenant) {
    return null;
  }

  if (!bodyTenant && typeof req.body === 'object' && req.body !== null) {
    req.body.tenantId = tokenTenant;
  }

  return tokenTenant;
}
