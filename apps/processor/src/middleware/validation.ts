import type { NextFunction, Request, Response } from 'express';
import { assertFileAccess } from '../services/rbac';

export async function ensureContentAccess(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const userId = req.serviceAuth?.userId;
  const contentHash =
    (typeof req.params?.contentHash === 'string' && req.params.contentHash) ||
    (typeof req.body?.contentHash === 'string' && req.body.contentHash) ||
    (typeof req.query?.contentHash === 'string' && req.query.contentHash) ||
    null;

  if (!contentHash) {
    res.status(400).json({ error: 'contentHash is required for this operation' });
    return;
  }

  if (!userId) {
    res.status(401).json({ error: 'Service authentication required' });
    return;
  }

  try {
    await assertFileAccess(userId, contentHash, 'view');
    next();
  } catch (error) {
    res.status(403).json({ error: 'Access denied for requested file' });
  }
}
