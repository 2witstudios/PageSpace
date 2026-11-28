import express, { Router } from 'express';
import type { Router as ExpressRouter } from 'express';
import { contentStore } from '../server';
import { isValidContentHash } from '../cache/content-store';
import { rateLimitUpload } from '../middleware/rate-limit';
import { verifyContentHash } from '../services/processing-pipeline';
import { MAX_VERIFY_BYTES } from './verify-core';
import { isHashBlocked } from '@pagespace/lib/content-safety/blocklist';
import { loggers } from '@pagespace/lib/logging/logger-config';

/**
 * Largest original this endpoint accepts: the largest file any drive may hold,
 * the same ceiling the verify endpoint uses. The web caller has already applied
 * the destination drive's own tier limit; this is the backstop on the body.
 */
export const MAX_STORE_ORIGINAL_BYTES = MAX_VERIFY_BYTES;

const router: ExpressRouter = Router();

/**
 * The request body as the file's bytes, or null when it is anything else: not
 * a Buffer (wrong content type, so `express.raw` left it unparsed), an array or
 * a string (a tampered parser), or empty. Narrowed once, here, so everything
 * after works on a definite non-empty Buffer.
 */
function originalBytesOf(body: unknown): Buffer | null {
  if (Array.isArray(body) || typeof body === 'string' || !Buffer.isBuffer(body)) return null;
  return body.byteLength > 0 ? body : null;
}

/** A single header value, or '' when absent or repeated (an array). */
function singleHeader(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Store the original bytes of a FILE page the web service is about to create.
 *
 * Browser uploads PUT straight to storage, but a file the SERVER produces — an
 * agent's sandbox output filed into the drive by `copy_content` — has its bytes
 * in the web process. Writing them here instead of with a bare S3 put routes
 * them through `ContentStore.saveOriginal`, the one place that applies at-rest
 * encryption (`FILE_ENCRYPTION_ENABLED`) and records upload metadata, so these
 * originals are stored exactly as every other processor-written original is.
 *
 * Page-bound like `/api/ingest`: the token is minted by
 * `createUploadServiceToken` for the NEW page id (which has no row yet), after
 * the web service checked edit access on the parent. The body is raw bytes;
 * `X-Content-Hash` is the SHA-256 the web service computed and checked against
 * the content blocklist. It is re-derived here from the bytes actually
 * received, so the content address can never name bytes it does not hold.
 *
 * Response contract:
 *   200 { ok:true, contentHash, size, stored }  stored (or already present: stored:false)
 *   422 { ok:false, reason:'hash_mismatch' }    bytes do not hash to X-Content-Hash
 *   410                                         hash is on the content blocklist
 *   400 invalid hash / empty body | 401 no auth | 403 binding | 413 too large
 */
router.post(
  '/:pageId',
  rateLimitUpload,
  express.raw({ type: 'application/octet-stream', limit: MAX_STORE_ORIGINAL_BYTES }),
  async (req, res) => {
    try {
      const auth = req.auth;
      if (!auth) {
        return res.status(401).json({ error: 'Service authentication required' });
      }

      const { pageId } = req.params as { pageId: string };
      const binding = auth.resourceBinding;
      if (!binding || binding.type !== 'page' || binding.id !== pageId) {
        loggers.security.warn('store-original denied: token not bound to this page', {
          userId: auth.userId,
          requestedPageId: pageId,
          binding: binding ? `${binding.type}:${binding.id}` : null,
        });
        return res.status(403).json({ error: 'Access denied: token is not bound to this page' });
      }

      const declared = singleHeader(req.headers['x-content-hash']).toLowerCase();
      if (!isValidContentHash(declared)) {
        return res.status(400).json({ error: 'Invalid content hash' });
      }

      const body = originalBytesOf(req.body);
      if (body === null) {
        return res.status(400).json({ error: 'Request body must be the file bytes (application/octet-stream)' });
      }
      const size = body.byteLength;

      if (!verifyContentHash(body, declared)) {
        loggers.security.warn('store-original: bytes do not match the declared hash', {
          userId: auth.userId,
          pageId,
          declared,
        });
        return res.status(422).json({ ok: false, reason: 'hash_mismatch' });
      }

      if (await isHashBlocked(declared)) {
        return res.status(410).json({ error: 'This file has been removed' });
      }

      // Content-addressed: present bytes are these bytes, so a second store is a no-op.
      if (await contentStore.originalExists(declared)) {
        return res.json({ ok: true, contentHash: declared, size, stored: false });
      }

      const rawName = singleHeader(req.headers['x-original-name']);
      let originalName = 'file';
      if (rawName !== '') {
        try {
          originalName = decodeURIComponent(rawName);
        } catch {
          originalName = rawName;
        }
      }

      await contentStore.saveOriginal(
        body,
        originalName,
        { userId: auth.userId, driveId: auth.driveId, service: 'web' },
        // Verified just above: the bytes hash to `declared`.
        declared,
      );
      return res.json({ ok: true, contentHash: declared, size, stored: true });
    } catch (error) {
      loggers.processor.error('store-original failed', error as Error);
      return res.status(500).json({ error: 'Failed to store original' });
    }
  },
);

export const storeOriginalRouter: ExpressRouter = router;
