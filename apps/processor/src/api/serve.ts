import { Router } from 'express';
import type { Router as ExpressRouter } from 'express';
import path from 'path';
import { contentStore } from '../server';
import { InvalidContentHashError, isValidContentHash } from '../cache/content-store';
import { assertFileAccess } from '../services/rbac';

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

    try {
      await assertFileAccess(userId, contentHash, 'view');
    } catch {
      return res.status(403).json({ error: 'Access denied for requested file' });
    }

    const buffer = await contentStore.getOriginal(contentHash);

    if (!buffer) {
      return res.status(404).json({ error: 'Original file not found' });
    }

    // Try to get metadata for content type
    const metadataPath = path.join(
      path.dirname(await contentStore.getOriginalPath(contentHash)),
      'metadata.json'
    );
    
    let contentType = 'application/octet-stream';
    let originalName = 'file';
    
    try {
      const fs = await import('fs');
      const metadata = JSON.parse(await fs.promises.readFile(metadataPath, 'utf-8'));
      originalName = metadata.originalName || 'file';
      
      // Guess content type from original name
      const ext = path.extname(originalName).toLowerCase();
      const mimeTypes: Record<string, string> = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.pdf': 'application/pdf',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.txt': 'text/plain',
        '.md': 'text/markdown'
      };
      
      contentType = mimeTypes[ext] || contentType;
    } catch {
      // Metadata not available
    }

    res.set({
      'Content-Type': contentType,
      'Content-Length': buffer.length.toString(),
      'Content-Disposition': `inline; filename="${originalName}"`,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'ETag': `"${contentHash}-original"`,
      'X-Content-Hash': contentHash,
      'X-Content-Type-Options': 'nosniff'
    });

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
