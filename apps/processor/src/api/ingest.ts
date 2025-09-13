import { Router } from 'express';
import type { Router as ExpressRouter } from 'express';
import { queueManager } from '../server';
import { getPageForIngestion } from '../db';

const router = Router();

// Enqueue ingestion job by pageId
router.post('/by-page/:pageId', async (req, res) => {
  try {
    const { pageId } = req.params;
    const page = await getPageForIngestion(pageId);

    if (!page) {
      return res.status(404).json({ error: 'Page not found' });
    }

    const { contentHash, mimeType, originalFileName } = page;
    if (!contentHash) {
      return res.status(400).json({ error: 'Page missing contentHash (filePath)' });
    }

    const jobId = await queueManager.addJob('ingest-file', {
      contentHash,
      fileId: pageId,
      mimeType: mimeType || 'application/octet-stream',
      originalName: originalFileName || 'file'
    });

    return res.json({ success: true, jobId });

  } catch (error) {
    console.error('Failed to enqueue ingestion:', error);
    return res.status(500).json({ error: 'Failed to enqueue ingestion' });
  }
});

export const ingestRouter: ExpressRouter = router;

