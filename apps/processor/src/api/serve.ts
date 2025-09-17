import { Router } from 'express';
import type { Router as ExpressRouter } from 'express';
import { contentStore } from '../server';
import path from 'path';

const router = Router();

// Serve original files (must come before generic preset route)
router.get('/:contentHash/original', async (req, res) => {
  try {
    const { contentHash } = req.params;
    
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
      'X-Content-Hash': contentHash
    });

    res.send(buffer);

  } catch (error) {
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
      'X-Content-Hash': contentHash
    });

    // Check if client has cached version
    const clientETag = req.headers['if-none-match'];
    if (clientETag === `"${contentHash}-${preset}"`) {
      return res.status(304).end(); // Not Modified
    }

    res.send(buffer);

  } catch (error) {
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
    
    const metadataPath = path.join(
      path.dirname(await contentStore.getCachePath(contentHash, 'dummy')),
      'metadata.json'
    );
    
    const fs = await import('fs');
    const metadata = JSON.parse(await fs.promises.readFile(metadataPath, 'utf-8'));
    
    res.json(metadata);

  } catch (error) {
    res.status(404).json({ error: 'Metadata not found' });
  }
});

export const cacheRouter: ExpressRouter = router;