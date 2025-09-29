import type { NextFunction, Request, Response } from 'express';
import { contentStore } from '../server';
import { requireTenantContext } from './auth';

export function ensureTenantContextPresent(req: Request, res: Response, next: NextFunction): void {
  const tokenTenant = req.serviceAuth?.tenantId;
  const resolvedTenant = requireTenantContext(req);

  if (tokenTenant && resolvedTenant === null) {
    res.status(403).json({ error: 'Tenant mismatch for request' });
    return;
  }

  if (!tokenTenant && !resolvedTenant) {
    res.status(400).json({ error: 'Tenant context is required' });
    return;
  }

  next();
}

export async function ensureContentAccess(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const tenantId = req.serviceAuth?.tenantId;
  const contentHash =
    (typeof req.params?.contentHash === 'string' && req.params.contentHash) ||
    (typeof req.body?.contentHash === 'string' && req.body.contentHash) ||
    (typeof req.query?.contentHash === 'string' && req.query.contentHash) ||
    null;

  if (!contentHash) {
    res.status(400).json({ error: 'contentHash is required for this operation' });
    return;
  }

  if (!tenantId) {
    res.status(403).json({ error: 'Tenant context required to access file' });
    return;
  }

  const allowed = await contentStore.tenantHasAccess(contentHash, tenantId);
  if (!allowed) {
    res.status(403).json({ error: 'Access denied for requested file' });
    return;
  }

  next();
}
