import type { NextFunction, Request, Response } from 'express';
import { loggers } from '@pagespace/lib/logger-config';
import { isValidContentHash } from '../cache/content-store';

type ContentHashSource = 'params' | 'body';

function respondForbidden(res: Response, message: string): void {
  res.status(403).json({ error: message });
}

/**
 * Fast-fail middleware for resource binding validation.
 *
 * For file-bound tokens, immediately rejects requests where the contentHash
 * doesn't match the token's binding. For page/drive bindings, passes through
 * to the authorization service which needs to lookup file links.
 *
 * This middleware should be placed AFTER authenticateService and requireScope.
 */
export function requireResourceBinding(contentHashSource: ContentHashSource = 'params') {
  return function resourceBindingMiddleware(req: Request, res: Response, next: NextFunction): void {
    const auth = req.auth;

    // No auth context - let route handler deal with it
    if (!auth) {
      next();
      return;
    }

    const binding = auth.resourceBinding;

    // Unbound tokens pass through - RBAC will still enforce permissions
    if (!binding) {
      next();
      return;
    }

    // Only fast-fail for file-bound tokens - page/drive need link lookup
    if (binding.type !== 'file') {
      next();
      return;
    }

    // Extract contentHash based on source
    let contentHash: string | undefined;

    if (contentHashSource === 'params') {
      contentHash = req.params.contentHash;
    } else if (contentHashSource === 'body') {
      contentHash = req.body?.contentHash;
    }

    // If no contentHash in expected location, let route handler validate
    if (!contentHash) {
      next();
      return;
    }

    // Validate contentHash format before comparing
    if (!isValidContentHash(contentHash)) {
      // Let route handler return proper validation error
      next();
      return;
    }

    // Normalize for comparison
    const normalizedHash = contentHash.toLowerCase();
    const normalizedBindingId = binding.id.toLowerCase();

    // Fast-fail: file-bound token accessing different file
    if (normalizedBindingId !== normalizedHash) {
      loggers.security.warn('resource-binding middleware: file binding mismatch', {
        userId: auth.userId,
        requestedHash: normalizedHash,
        boundHash: normalizedBindingId,
        endpoint: req.path,
        method: req.method,
      });
      respondForbidden(res, 'Access denied: token is bound to a different file');
      return;
    }

    // File binding matches - proceed to route handler
    next();
  };
}

/**
 * Middleware for page-bound routes (like /api/ingest/by-page/:pageId).
 *
 * Fast-fails if a page-bound token doesn't match the requested pageId.
 * File/drive bindings pass through to the authorization service.
 */
export function requirePageBinding() {
  return function pageBindingMiddleware(req: Request, res: Response, next: NextFunction): void {
    const auth = req.auth;

    if (!auth) {
      next();
      return;
    }

    const binding = auth.resourceBinding;

    if (!binding) {
      next();
      return;
    }

    // Only fast-fail for page-bound tokens
    if (binding.type !== 'page') {
      next();
      return;
    }

    const pageId = req.params.pageId;

    if (!pageId) {
      next();
      return;
    }

    if (binding.id !== pageId) {
      loggers.security.warn('resource-binding middleware: page binding mismatch', {
        userId: auth.userId,
        requestedPageId: pageId,
        boundPageId: binding.id,
        endpoint: req.path,
        method: req.method,
      });
      respondForbidden(res, 'Access denied: token is bound to a different page');
      return;
    }

    next();
  };
}
