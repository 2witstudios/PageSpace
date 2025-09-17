import { Router } from 'express';
import type { Router as ExpressRouter } from 'express';
import multer from 'multer';
import crypto from 'crypto';
import { contentStore, queueManager } from '../server';
import { needsTextExtraction } from '../workers/text-extractor';
import { needsOCR } from '../workers/ocr-processor';
import { Readable } from 'stream';

const router = Router();

// Configure multer for streaming to disk
const storage = multer.memoryStorage(); // We'll handle the streaming ourselves

const upload = multer({
  storage,
  limits: {
    fileSize: parseInt(process.env.STORAGE_MAX_FILE_SIZE_MB || '20') * 1024 * 1024, // 20MB default for VPS
    files: 3 // Max 3 files at once (reduced for VPS)
  }
});

// Single file upload with streaming
router.post('/single', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const { buffer, originalname, mimetype, size } = req.file;
    const { pageId, userId } = req.body;

    console.log(`Uploading file: ${originalname} (${size} bytes)`);

    // Calculate content hash
    const contentHash = crypto.createHash('sha256').update(buffer).digest('hex');

    // Check if file already exists (deduplication)
    const existing = await contentStore.getOriginal(contentHash);
    if (existing) {
      console.log(`File already exists with hash: ${contentHash}`);
      
      // Still queue processing jobs if needed
      await queueProcessingJobs(contentHash, originalname, mimetype, pageId);
      
      return res.json({
        success: true,
        contentHash,
        deduplicated: true,
        size,
        jobs: await getQueuedJobs(contentHash, mimetype)
      });
    }

    // Save original file
    const { path } = await contentStore.saveOriginal(buffer, originalname);
    console.log(`Saved original file to: ${path}`);

    // Queue processing jobs based on file type
    const jobs = await queueProcessingJobs(contentHash, originalname, mimetype, pageId);

    res.json({
      success: true,
      contentHash,
      deduplicated: false,
      size,
      path,
      jobs
    });

  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ 
      error: 'Upload failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Multiple file upload
router.post('/multiple', upload.array('files', 10), async (req, res) => {
  try {
    if (!req.files || !Array.isArray(req.files)) {
      return res.status(400).json({ error: 'No files provided' });
    }

    const { pageId, userId } = req.body;
    const results = [];

    for (const file of req.files) {
      const { buffer, originalname, mimetype, size } = file;
      
      // Calculate content hash
      const contentHash = crypto.createHash('sha256').update(buffer).digest('hex');

      // Check for deduplication
      const existing = await contentStore.getOriginal(contentHash);
      
      if (!existing) {
        await contentStore.saveOriginal(buffer, originalname);
      }

      // Queue processing jobs
      const jobs = await queueProcessingJobs(contentHash, originalname, mimetype, pageId);

      results.push({
        originalname,
        contentHash,
        size,
        deduplicated: !!existing,
        jobs
      });
    }

    res.json({
      success: true,
      files: results
    });

  } catch (error) {
    console.error('Multiple upload error:', error);
    res.status(500).json({ 
      error: 'Upload failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Chunked upload endpoint for large files
router.post('/chunk', async (req, res) => {
  // This would handle chunked uploads for very large files
  // Implementation depends on frontend chunking strategy
  res.status(501).json({ error: 'Chunked upload not yet implemented' });
});

// Helper function to queue appropriate processing jobs (unified ingestion)
async function queueProcessingJobs(
  contentHash: string,
  originalName: string,
  mimeType: string,
  pageId?: string
): Promise<string[]> {
  const jobIds: string[] = [];
  const jobId = await queueManager.addJob('ingest-file', {
    contentHash,
    fileId: pageId,
    mimeType,
    originalName
  });
  jobIds.push(jobId);
  return jobIds;
}

async function getQueuedJobs(contentHash: string, mimeType: string): Promise<any> {
  const jobs: any = { ingest: true };
  return jobs;
}

export const uploadRouter: ExpressRouter = router;
