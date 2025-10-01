import { Router } from 'express';
import type { Router as ExpressRouter } from 'express';
import { contentStore } from '../server';
import { InvalidContentHashError, isValidContentHash } from '../cache/content-store';
import { assertFileAccess, checkFileAccess } from '../services/rbac';
import { db, files, pages, eq } from '@pagespace/db';
import { sanitizeFilename, isDangerousMimeType } from '../utils/security';

const router = Router();

// Serve original files (must come before generic preset route)
router.get('/:contentHash/original', async (req, res) => {
  try {
    const { contentHash } = req.params;
    const auth = req.serviceAuth;

    if (!auth) {
      return res.status(401).json({ error: 'Service authentication required' });
    }

    if (!isValidContentHash(contentHash)) {
      return res.status(400).json({ error: 'Invalid content hash' });
    }

    const userId = auth.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Service authentication required' });
    }

    let accessInfo;
    try {
      accessInfo = await checkFileAccess(userId, contentHash, 'view');
      if (!accessInfo.allowed) {
        throw new Error('Access denied');
      }
    } catch {
      return res.status(403).json({ error: 'Access denied for requested file' });
    }

    const buffer = await contentStore.getOriginal(contentHash);

    if (!buffer) {
      return res.status(404).json({ error: 'Original file not found' });
    }

    let originalName = 'file';
    let contentType = 'application/octet-stream';
    let contentLength = buffer.length;

    const fileRecord = await db.query.files.findFirst({
      where: eq(files.id, contentHash),
    });

    if (typeof fileRecord?.sizeBytes === 'number') {
      contentLength = fileRecord.sizeBytes;
    }

    if (fileRecord?.mimeType) {
      contentType = fileRecord.mimeType;
    }

    const linkedPageId = accessInfo?.pageId;
    if (linkedPageId) {
      const pageRecord = await db.query.pages.findFirst({
        where: eq(pages.id, linkedPageId),
      });

      if (pageRecord?.originalFileName) {
        originalName = pageRecord.originalFileName;
      } else if (pageRecord?.title) {
        originalName = pageRecord.title;
      }

      if (!fileRecord?.mimeType && pageRecord?.mimeType) {
        contentType = pageRecord.mimeType;
      }
    }

    // Sanitize filename to prevent header injection
    const sanitizedFilename = sanitizeFilename(originalName);
    const isDangerous = isDangerousMimeType(contentType);

    res.set({
      'Content-Type': contentType,
      'Content-Length': contentLength.toString(),
      'Cache-Control': 'public, max-age=31536000, immutable',
      'ETag': `"${contentHash}-original"`,
      'X-Content-Hash': contentHash,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY'
    });

    // Force download for dangerous MIME types + strict CSP
    if (isDangerous) {
      res.set({
        'Content-Disposition': `attachment; filename="${sanitizedFilename}"`,
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox;"
      });
      console.warn('[Security] Forcing download for dangerous MIME type:', {
        contentHash,
        contentType,
        filename: sanitizedFilename
      });
    } else {
      res.set({
        'Content-Disposition': `inline; filename="${sanitizedFilename}"`,
        'Content-Security-Policy': "default-src 'none';"
      });
    }

    res.send(buffer);

  } catch (error) {
    if (error instanceof InvalidContentHashError) {
      return res.status(400).json({ error: 'Invalid content hash' });
    }

    console.error('Serve original error:', error);
    res.status(500).json({
      error: 'Failed to serve original file',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Serve cached files (generic route comes after specific routes)
router.get('/:contentHash/:preset', async (req, res) => {
  try {
    const { contentHash, preset } = req.params;
    const auth = req.serviceAuth;

    if (!auth) {
      return res.status(401).json({ error: 'Service authentication required' });
    }

    if (!isValidContentHash(contentHash)) {
      return res.status(400).json({ error: 'Invalid content hash' });
    }

    const userId = auth.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Service authentication required' });
    }

    try {
      await assertFileAccess(userId, contentHash, 'view');
    } catch {
      return res.status(403).json({ error: 'Access denied for requested file' });
    }

    // Get cached file
    const buffer = await contentStore.getCache(contentHash, preset);
    
    if (!buffer) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Determine content type based on preset or file extension
    let contentType = 'image/jpeg'; // Default
    
    if (preset.endsWith('.webp')) {
      contentType = 'image/webp';
    } else if (preset.endsWith('.png')) {
      contentType = 'image/png';
    } else if (preset === 'extracted-text.txt') {
      contentType = 'text/plain';
    } else if (preset === 'ocr-text.txt') {
      contentType = 'text/plain';
    }

    // Set cache headers for efficient caching
    res.set({
      'Content-Type': contentType,
      'Content-Length': buffer.length.toString(),
      'Cache-Control': 'public, max-age=31536000, immutable', // 1 year cache
      'ETag': `"${contentHash}-${preset}"`,
      'X-Content-Hash': contentHash,
      'X-Content-Type-Options': 'nosniff'
    });

    // Check if client has cached version
    const clientETag = req.headers['if-none-match'];
    if (clientETag === `"${contentHash}-${preset}"`) {
      return res.status(304).end(); // Not Modified
    }

    res.send(buffer);

  } catch (error) {
    if (error instanceof InvalidContentHashError) {
      return res.status(400).json({ error: 'Invalid content hash' });
    }

    console.error('Serve error:', error);
    res.status(500).json({
      error: 'Failed to serve file',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Get file metadata
router.get('/:contentHash/metadata', async (req, res) => {
  try {
    const { contentHash } = req.params;
    const auth = req.serviceAuth;

    if (!auth) {
      return res.status(401).json({ error: 'Service authentication required' });
    }

    if (!isValidContentHash(contentHash)) {
      return res.status(400).json({ error: 'Invalid content hash' });
    }

    const userId = auth.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Service authentication required' });
    }

    try {
      await assertFileAccess(userId, contentHash, 'view');
    } catch {
      return res.status(403).json({ error: 'Access denied for requested file' });
    }

    const metadata = await contentStore.getCacheMetadata(contentHash);
    if (!metadata || Object.keys(metadata).length === 0) {
      return res.status(404).json({ error: 'Metadata not found' });
    }

    const sanitized = Object.fromEntries(
      Object.entries(metadata).map(([preset, entry]) => [
        preset,
        {
          preset: entry.preset,
          size: entry.size,
          mimeType: entry.mimeType,
          createdAt: entry.createdAt instanceof Date ? entry.createdAt.toISOString() : String(entry.createdAt),
          lastAccessed:
            entry.lastAccessed instanceof Date
              ? entry.lastAccessed.toISOString()
              : String(entry.lastAccessed)
        }
      ])
    );

    res.json({ presets: sanitized });

  } catch (error) {
    if (error instanceof InvalidContentHashError) {
      return res.status(400).json({ error: 'Invalid content hash' });
    }

    console.error('Metadata fetch error:', error);
    res.status(500).json({ error: 'Failed to load metadata' });
  }
});

export const cacheRouter: ExpressRouter = router;
