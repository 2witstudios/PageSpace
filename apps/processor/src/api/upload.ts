import { Router } from 'express';
import type { Router as ExpressRouter } from 'express';
import multer from 'multer';
import crypto from 'crypto';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import { contentStore, queueManager } from '../server';
import { processorLogger } from '../logger';
import { rateLimitUpload } from '../middleware/rate-limit';
import { hasServiceScope } from '../middleware/auth';

const router = Router();

// Configure multer for disk storage to avoid memory exhaustion
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      // Use a temporary directory within the container
      const tempDir = path.join(process.env.CACHE_PATH || '/data/cache', 'temp-uploads');
      await fs.mkdir(tempDir, { recursive: true });
      cb(null, tempDir);
    } catch (error) {
      processorLogger.error('Failed to create temp upload directory', error as Error, {
        cachePath: process.env.CACHE_PATH,
        originalname: file.originalname
      });
      cb(error as Error, '');
    }
  },
  filename: (req, file, cb) => {
    // Generate unique filename to avoid conflicts
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1E9)}-${file.originalname}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: parseInt(process.env.STORAGE_MAX_FILE_SIZE_MB || '50') * 1024 * 1024, // Increased to 50MB with disk storage
    files: 5 // Can handle more files with disk storage
  },
  fileFilter: (req, file, cb) => {
    if (!file.originalname || file.originalname.length === 0) {
      cb(new Error('Invalid filename'));
      return;
    }

    const allowedTypes = ['image/', 'application/pdf', 'text/', 'application/vnd'];
    const isAllowed = allowedTypes.some(type => file.mimetype.startsWith(type));
    if (!isAllowed) {
      cb(new Error('Unsupported file type'));
      return;
    }

    cb(null, true);
  }
});

router.use((req, res, next) => {
  if (!req.serviceAuth) {
    return res.status(401).json({ error: 'Service authentication required' });
  }
  return next();
});

router.use(rateLimitUpload);

// Single file upload with disk storage
router.post('/single', upload.single('file'), async (req, res) => {
  let tempFilePath: string | undefined;

  try {
    const auth = req.serviceAuth;
    if (!auth) {
      return res.status(401).json({ error: 'Service authentication required' });
    }

    const resourcePageId = auth.claims.resource;
    if (!resourcePageId) {
      return res.status(403).json({ error: 'Service token missing page scope' });
    }

    const driveId = typeof req.body?.driveId === 'string' ? req.body.driveId : undefined;
    if (!driveId) {
      return res.status(400).json({ error: 'driveId is required' });
    }

    if (!auth.driveId || auth.driveId !== driveId) {
      return res.status(403).json({ error: 'Service token drive does not match requested drive' });
    }

    const pageId = typeof req.body?.pageId === 'string' ? req.body.pageId : undefined;
    if (!pageId) {
      return res.status(400).json({ error: 'pageId is required' });
    }

    if (resourcePageId && resourcePageId !== pageId) {
      return res.status(403).json({ error: 'Service token resource does not match requested page' });
    }

    const providedUserId = typeof req.body?.userId === 'string' ? req.body.userId : undefined;
    if (
      auth.userId &&
      providedUserId &&
      providedUserId !== auth.userId &&
      !hasServiceScope(auth, 'files:write:any')
    ) {
      return res.status(403).json({ error: 'Cannot upload on behalf of another user' });
    }

    const uploaderId = auth.userId ?? providedUserId;

    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const { path: tempPath, originalname, mimetype, size } = req.file;
    tempFilePath = tempPath;

    processorLogger.info('Processing uploaded file', {
      originalname,
      size,
      tempPath
    });

    // Calculate content hash from the temporary file
    const contentHash = await computeFileHash(tempPath);

    // Check if file already exists (deduplication)
    const alreadyStored = await contentStore.originalExists(contentHash);
    if (alreadyStored) {
      await contentStore.appendUploadMetadata(contentHash, {
        driveId,
        userId: uploaderId,
        service: auth.service
      });

      processorLogger.info('Upload deduplicated', {
        contentHash,
        originalname
      });

      try {
        await fs.unlink(tempPath);
      } catch (cleanupError) {
        processorLogger.warn('Failed to clean up temp upload after dedupe', {
          tempPath,
          error: cleanupError instanceof Error ? cleanupError.message : cleanupError
        });
      }

      await queueProcessingJobs(contentHash, originalname, mimetype, pageId);

      return res.json({
        success: true,
        contentHash,
        deduplicated: true,
        size,
        jobs: await getQueuedJobs(contentHash, mimetype)
      });
    }

    // Save original file from disk (much more efficient than memory)
    const { path: finalPath } = await contentStore.saveOriginalFromFile(
      tempPath,
      originalname,
      contentHash,
      {
        driveId,
        userId: uploaderId,
        service: auth.service
      }
    );
    processorLogger.info('Saved original upload', {
      contentHash,
      finalPath,
      originalname
    });

    // Clean up temporary file after successful save
    try {
      await fs.unlink(tempPath);
      tempFilePath = undefined; // Mark as cleaned up
    } catch (cleanupError) {
      processorLogger.warn('Failed to clean up temp upload after save', {
        tempPath,
        error: cleanupError instanceof Error ? cleanupError.message : cleanupError
      });
    }

    // Queue processing jobs based on file type
    const jobs = await queueProcessingJobs(contentHash, originalname, mimetype, pageId);

    res.json({
      success: true,
      contentHash,
      deduplicated: false,
      size,
      path: finalPath,
      jobs
    });

  } catch (error) {
    processorLogger.error('Upload error', error as Error, {
      tempFilePath,
      pageId: req.body?.pageId,
      userId: req.serviceAuth?.userId ?? req.body?.userId
    });

    // Clean up temporary file on error
    if (tempFilePath) {
      try {
        await fs.unlink(tempFilePath);
      } catch (cleanupError) {
        processorLogger.warn('Failed to clean up temp upload after error', {
          tempFilePath,
          error: cleanupError instanceof Error ? cleanupError.message : cleanupError
        });
      }
    }

    res.status(500).json({
      error: 'Upload failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Multiple file upload with disk storage
router.post('/multiple', upload.array('files', 10), async (req, res) => {
  const tempFilePaths: string[] = [];

  try {
    const auth = req.serviceAuth;
    if (!auth) {
      return res.status(401).json({ error: 'Service authentication required' });
    }

    const resourcePageId = auth.claims.resource;
    if (!resourcePageId) {
      return res.status(403).json({ error: 'Service token missing page scope' });
    }

    const driveId = typeof req.body?.driveId === 'string' ? req.body.driveId : undefined;
    if (!driveId) {
      return res.status(400).json({ error: 'driveId is required' });
    }

    if (!auth.driveId || auth.driveId !== driveId) {
      return res.status(403).json({ error: 'Service token drive does not match requested drive' });
    }

    const providedUserId = typeof req.body?.userId === 'string' ? req.body.userId : undefined;
    if (
      auth.userId &&
      providedUserId &&
      providedUserId !== auth.userId &&
      !hasServiceScope(auth, 'files:write:any')
    ) {
      return res.status(403).json({ error: 'Cannot upload on behalf of another user' });
    }

    const uploaderId = auth.userId ?? providedUserId;

    if (!req.files || !Array.isArray(req.files)) {
      return res.status(400).json({ error: 'No files provided' });
    }

    const pageId = typeof req.body?.pageId === 'string' ? req.body.pageId : undefined;
    if (resourcePageId && pageId && resourcePageId !== pageId) {
      return res.status(403).json({ error: 'Service token resource does not match requested page' });
    }
    const results = [];

    // Track temp files for cleanup
    for (const file of req.files) {
      tempFilePaths.push(file.path);
    }

    for (const file of req.files) {
      const { path: tempPath, originalname, mimetype, size } = file;

      try {
        // Calculate content hash from file
        const contentHash = await computeFileHash(tempPath);

        // Check for deduplication
        const alreadyStored = await contentStore.originalExists(contentHash);

        if (!alreadyStored) {
          await contentStore.saveOriginalFromFile(tempPath, originalname, contentHash, {
            driveId,
            userId: uploaderId,
            service: auth.service
          });
        }
        if (alreadyStored) {
          await contentStore.appendUploadMetadata(contentHash, {
            driveId,
            userId: uploaderId,
            service: auth.service
          });
        }

        // Queue processing jobs
        const jobs = await queueProcessingJobs(contentHash, originalname, mimetype, pageId);

        results.push({
          originalname,
          contentHash,
          size,
          deduplicated: alreadyStored,
          jobs
        });

      } catch (fileError) {
        processorLogger.error(`Error processing file ${originalname}`, fileError as Error, {
          tempPath,
          pageId,
          userId: uploaderId
        });
        results.push({
          originalname,
          error: `Failed to process file: ${fileError instanceof Error ? fileError.message : 'Unknown error'}`,
          success: false
        });
      }
    }

    // Clean up all temporary files
    for (const tempPath of tempFilePaths) {
      try {
        await fs.unlink(tempPath);
      } catch (cleanupError) {
        processorLogger.warn('Failed to clean up temp upload after multi-file processing', {
          tempPath,
          error: cleanupError instanceof Error ? cleanupError.message : cleanupError
        });
      }
    }

    res.json({
      success: true,
      files: results
    });

  } catch (error) {
    processorLogger.error('Multiple upload error', error as Error, {
      count: tempFilePaths.length
    });

    // Clean up temporary files on error
    for (const tempPath of tempFilePaths) {
      try {
        await fs.unlink(tempPath);
      } catch (cleanupError) {
        processorLogger.warn('Failed to clean up temp upload after multi-upload error', {
          tempPath,
          error: cleanupError instanceof Error ? cleanupError.message : cleanupError
        });
      }
    }

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

async function computeFileHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath);

    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
