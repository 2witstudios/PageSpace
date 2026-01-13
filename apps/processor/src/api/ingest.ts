import { Router } from 'express';
import type { Router as ExpressRouter } from 'express';
import { queueManager } from '../server';
import { getPageForIngestion } from '../db';
import { InvalidContentHashError, isValidContentHash } from '../cache/content-store';
import { assertFileAccess } from '../services/rbac';

const router = Router();

// Enqueue ingestion job by pageId
router.post('/by-page/:pageId', async (req, res) => {
  try {
    if (!req.auth) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const userId = req.auth.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Service authentication required' });
    }

    const { pageId } = req.params;
    const page = await getPageForIngestion(pageId);

    if (!page) {
      return res.status(404).json({ error: 'Page not found' });
    }

    const { contentHash, mimeType, originalFileName } = page;
    if (!contentHash) {
      return res.status(400).json({ error: 'Page missing contentHash (filePath)' });
    }

    if (!isValidContentHash(contentHash)) {
      return res.status(400).json({ error: 'Page content hash is invalid' });
    }

    try {
      await assertFileAccess(userId, contentHash, 'edit');
    } catch {
      return res.status(403).json({ error: 'Access denied for requested file' });
    }

    const jobId = await queueManager.addJob('ingest-file', {
      contentHash,
      fileId: pageId,
      mimeType: mimeType || 'application/octet-stream',
      originalName: originalFileName || 'file'
    });

    return res.json({ success: true, jobId });

  } catch (error) {
    if (error instanceof InvalidContentHashError) {
      return res.status(400).json({ error: 'Invalid content hash' });
    }

    console.error('Failed to enqueue ingestion:', error);
    return res.status(500).json({ error: 'Failed to enqueue ingestion' });
  }
});

export const ingestRouter: ExpressRouter = router;
