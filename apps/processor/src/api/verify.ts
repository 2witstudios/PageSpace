import { Router } from 'express';
import type { Router as ExpressRouter, Response } from 'express';
import { contentStore } from '../server';
import { isValidContentHash } from '../cache/content-store';
import { verifyContentHash, detectContentType, isAllowedContentType } from '../services/processing-pipeline';
import { classifyObjectSize, verifyResponse } from './verify-core';
import { loggers } from '@pagespace/lib/logging/logger-config';

const router = Router();

/**
 * Synchronous byte verification for direct-to-S3 attachment uploads.
 *
 * Channel/DM attachments PUT their bytes straight to S3, so no server ever sees
 * them in transit. This endpoint re-reads the stored object and re-hashes it —
 * zero-trust: the stored bytes MUST hash to the claimed content hash, or a client
 * could PUT arbitrary bytes under a key it doesn't own and poison the
 * content-addressed store (a later legitimate upload of that hash would dedup to
 * the attacker's bytes). On a mismatch the corrupt object is deleted so it can't
 * become a dedup target. On a match it runs Magika and reports the true MIME type,
 * which the web /complete step stores instead of the client-declared type.
 *
 * The object size is probed with a cheap HEAD first: an object larger than
 * MAX_VERIFY_BYTES is rejected before any bytes are buffered onto this request
 * thread, and the HEAD distinguishes a genuinely absent object from a transient
 * S3 failure (getOriginal alone cannot — it collapses both into null).
 *
 * Unlike /api/ingest this is NOT page-bound — it accepts a conversation- or
 * page-bound `files:write` token and verifies a hash supplied by the (trusted)
 * web service from a presign-reserved slot. The bytes are read from S3 here, so
 * they still never transit the web service.
 *
 * Response contract — see {@link verifyResponse}:
 *   200 { ok:true,  detectedMime, detectedLabel, size }  verified; store detectedMime
 *   200 { ok:false, reason:'hash_mismatch' }             definitive; object deleted; do NOT retry
 *   200 { ok:false, reason:'blocked_type', label }       definitive; disallowed type, object deleted; do NOT retry
 *   200 { ok:false, reason:'object_not_found' }          definitive; object absent; do NOT retry
 *   413 { ok:false, reason:'object_too_large' }          rejected before download; do NOT retry
 *   503 { ok:false, reason:'storage_error' }             transient infra failure; caller MAY retry
 *   400 invalid hash | 401 missing auth | 403 missing binding | 500 unexpected
 */
router.post('/', async (req, res) => {
  try {
    const auth = req.auth;
    if (!auth) {
      return res.status(401).json({ error: 'Service authentication required' });
    }

    // Require a page or conversation binding so an unbound token can't probe
    // arbitrary content-addressed objects.
    const binding = auth.resourceBinding;
    if (!binding || (binding.type !== 'page' && binding.type !== 'conversation')) {
      return res.status(403).json({ error: 'Token missing valid resource binding' });
    }

    const contentHash = typeof req.body?.contentHash === 'string' ? req.body.contentHash : undefined;
    if (!contentHash || !isValidContentHash(contentHash)) {
      return res.status(400).json({ error: 'Invalid content hash' });
    }

    // Pre-download probe: size guard + absent-vs-infra distinction. A thrown
    // error here is a genuine infra failure (HEAD re-throws those) → retryable.
    let size: number | null;
    try {
      size = await contentStore.headOriginalSize(contentHash);
    } catch (err) {
      loggers.processor.error('Attachment verify: HEAD probe failed', err as Error, { contentHash });
      return send(res, verifyResponse({ kind: 'storage_error' }));
    }

    const sizeClass = classifyObjectSize(size);
    if (sizeClass === 'absent') {
      return send(res, verifyResponse({ kind: 'absent' }));
    }
    if (sizeClass === 'too_large') {
      loggers.security.warn('Attachment verify: object exceeds size cap', { contentHash, size });
      return send(res, verifyResponse({ kind: 'too_large', size: size as number }));
    }

    const bytes = await contentStore.getOriginal(contentHash);
    if (!bytes) {
      // The object was present at HEAD but unreadable now — treat as transient.
      loggers.processor.warn('Attachment verify: object readable at HEAD but not at GET', { contentHash });
      return send(res, verifyResponse({ kind: 'storage_error' }));
    }

    // Zero-trust: the stored bytes must hash to the declared content hash.
    if (!verifyContentHash(bytes, contentHash)) {
      loggers.security.warn('Attachment verify: hash mismatch — deleting object', { contentHash });
      try {
        await contentStore.deleteOriginal(contentHash);
      } catch (err) {
        loggers.processor.error('Failed to delete mismatched attachment object', err as Error, { contentHash });
      }
      return send(res, verifyResponse({ kind: 'mismatch' }));
    }

    // Magika on the actual bytes — the true MIME type the web layer stores in
    // attachmentMeta, overriding the client-declared type.
    const detected = await detectContentType(bytes);

    // Zero-trust content-type denylist (parity with the page-file ingest path,
    // s3-pull-adapter.ts): reject + delete browser-executable markup, scripts, and
    // native executables based on the ACTUAL bytes, regardless of the declared MIME.
    // presign's validateMimeTypeDeclaration blocks these when *declared*; this closes
    // the spoof where a client declares image/png but uploads SVG/HTML/EXE bytes
    // (which would otherwise be stored with the detected type and served inline).
    if (!isAllowedContentType(detected)) {
      loggers.security.warn('Attachment verify: disallowed content type — deleting object', { contentHash, label: detected.label });
      try {
        await contentStore.deleteOriginal(contentHash);
      } catch (err) {
        loggers.processor.error('Failed to delete disallowed attachment object', err as Error, { contentHash });
      }
      return send(res, verifyResponse({ kind: 'blocked_type', label: detected.label }));
    }

    return send(
      res,
      verifyResponse({ kind: 'match', detectedMime: detected.mimeType, detectedLabel: detected.label, size: bytes.length }),
    );
  } catch (error) {
    loggers.processor.error('Attachment verify failed', error as Error);
    return res.status(500).json({ error: 'Verification failed' });
  }
});

function send(res: Response, r: { status: number; body: Record<string, unknown> }): Response {
  return res.status(r.status).json(r.body);
}

export const verifyRouter: ExpressRouter = router;
