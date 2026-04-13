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
import { hasAuthScope } from '../middleware/auth';
import { resolvePathWithin, sanitizeExtension } from '../utils/security';
import { detectContentType } from '../services/content-detector';

const DENIED_LABELS: ReadonlySet<string> = new Set([
  'pebin',
  'elf',
  'macho',
  'dex',
  'html',
  'svg',
  'xhtml',
]);

const router = Router();

const CACHE_ROOT = path.resolve(process.env.CACHE_PATH || '/data/cache');
const TEMP_UPLOADS_DIR = resolvePathWithin(CACHE_ROOT, 'temp-uploads');

/* c8 ignore next 3 */
if (!TEMP_UPLOADS_DIR) {
  throw new Error('Invalid upload cache path configuration');
}

// Configure multer for disk storage to avoid memory exhaustion
// These callbacks are exercised in integration tests; unit tests mock multer entirely.
/* c8 ignore start */
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      await fs.mkdir(TEMP_UPLOADS_DIR, { recursive: true });
      cb(null, TEMP_UPLOADS_DIR);
    } catch (error) {
      processorLogger.error('Failed to create temp upload directory', error as Error, {
        cachePath: process.env.CACHE_PATH,
        originalname: file.originalname
      });
      cb(error as Error, '');
    }
  },
  filename: (req, file, cb) => {
    try {
      const safeExt = sanitizeExtension(file.originalname);
      const uniqueName = `${Date.now()}-${crypto.randomUUID()}${safeExt}`;
      const safePath = resolvePathWithin(TEMP_UPLOADS_DIR, uniqueName);

      if (!safePath) {
        processorLogger.warn('Rejected unsafe upload filename', {
          originalname: file.originalname,
          generatedName: uniqueName
        });
        cb(new Error('Unsafe upload path generated'), uniqueName);
        return;
      }

      cb(null, path.basename(safePath));
    } catch (error) {
      processorLogger.error('Failed to generate safe upload filename', error as Error, {
        originalname: file.originalname
      });
      cb(new Error('Failed to generate safe upload filename'), '');
    }
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: parseInt(process.env.STORAGE_MAX_FILE_SIZE_MB || '50') * 1024 * 1024, // Increased to 50MB with disk storage
    files: 5 // Can handle more files with disk storage
  },
  fileFilter: (_req, file, cb) => {
    if (!file.originalname || file.originalname.length === 0) {
      cb(new Error('Invalid filename'));
      return;
    }
    cb(null, true);
  }
});
/* c8 ignore stop */

router.use((req, res, next) => {
  if (!req.auth) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  return next();
});

router.use(rateLimitUpload);

// Single file upload with disk storage
router.post('/single', upload.single('file'), async (req, res) => {
  let tempFilePath: string | undefined;

  try {
    const auth = req.auth;
    /* c8 ignore next 3 */
    if (!auth) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Get resource binding (pageId) from session
    const resourcePageId = auth.resourceBinding?.type === 'page' ? auth.resourceBinding.id : undefined;
    if (!resourcePageId) {
      return res.status(403).json({ error: 'Token missing page resource binding' });
    }

    const driveId = typeof req.body?.driveId === 'string' ? req.body.driveId : undefined;
    if (!driveId) {
      return res.status(400).json({ error: 'driveId is required' });
    }

    if (!auth.driveId || auth.driveId !== driveId) {
      return res.status(403).json({ error: 'Token drive does not match requested drive' });
    }

    const pageId = typeof req.body?.pageId === 'string' ? req.body.pageId : undefined;
    if (!pageId) {
      return res.status(400).json({ error: 'pageId is required' });
    }

    if (resourcePageId && resourcePageId !== pageId) {
      return res.status(403).json({ error: 'Token resource does not match requested page' });
    }

    const providedUserId = typeof req.body?.userId === 'string' ? req.body.userId : undefined;
    if (
      auth.userId &&
      providedUserId &&
      providedUserId !== auth.userId &&
      !hasAuthScope(auth, 'files:write:any')
    ) {
      return res.status(403).json({ error: 'Cannot upload on behalf of another user' });
    }

    const uploaderId = auth.userId ?? providedUserId;

    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const { path: tempPath, originalname, size } = req.file;

    // Verify temp file is within expected upload directory (defense-in-depth)
    const normalizedTemp = path.resolve(tempPath);
    if (!normalizedTemp.startsWith(path.resolve(TEMP_UPLOADS_DIR) + path.sep)) {
      return res.status(400).json({ error: 'Invalid upload file path' });
    }
    tempFilePath = tempPath;

    processorLogger.info('Processing uploaded file', {
      originalname,
      size,
      tempPath
    });

    const detected = await detectContentType(tempPath);
    if (DENIED_LABELS.has(detected.label)) {
      try {
        await fs.unlink(tempPath);
      } catch (cleanupError) {
        processorLogger.warn('Failed to clean up temp upload after denylist rejection', {
          tempPath,
          error: cleanupError instanceof Error ? cleanupError.message : cleanupError
        });
      }
      tempFilePath = undefined;
      return res.status(415).json({
        error: 'Unsupported file type',
        detectedLabel: detected.label
      });
    }

    const verifiedMimeType = detected.mimeType;
    const detectedLabel = detected.label;

    // Calculate content hash from the temporary file
    const contentHash = await computeFileHash(tempPath);

    // Check if file already exists (deduplication)
    const alreadyStored = await contentStore.originalExists(contentHash);
    if (alreadyStored) {
      await contentStore.appendUploadMetadata(contentHash, {
        tenantId: auth.userId,
        driveId,
        userId: uploaderId,
        service: 'processor'
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

      const jobs = await queueProcessingJobs(
        contentHash,
        originalname,
        verifiedMimeType,
        pageId,
        detectedLabel
      );

      return res.json({
        success: true,
        contentHash,
        deduplicated: true,
        size,
        jobs
      });
    }

    // Save original file from disk (much more efficient than memory)
    const { path: finalPath } = await contentStore.saveOriginalFromFile(
      tempPath,
      originalname,
      contentHash,
      {
        tenantId: auth.userId,
        driveId,
        userId: uploaderId,
        service: 'processor'
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
    const jobs = await queueProcessingJobs(
      contentHash,
      originalname,
      verifiedMimeType,
      pageId,
      detectedLabel
    );

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
      userId: req.auth?.userId ?? req.body?.userId
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
    const auth = req.auth;
    /* c8 ignore next 3 */
    if (!auth) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Get resource binding (pageId) from session
    const resourcePageId = auth.resourceBinding?.type === 'page' ? auth.resourceBinding.id : undefined;
    if (!resourcePageId) {
      return res.status(403).json({ error: 'Token missing page resource binding' });
    }

    const driveId = typeof req.body?.driveId === 'string' ? req.body.driveId : undefined;
    if (!driveId) {
      return res.status(400).json({ error: 'driveId is required' });
    }

    if (!auth.driveId || auth.driveId !== driveId) {
      return res.status(403).json({ error: 'Token drive does not match requested drive' });
    }

    const providedUserId = typeof req.body?.userId === 'string' ? req.body.userId : undefined;
    if (
      auth.userId &&
      providedUserId &&
      providedUserId !== auth.userId &&
      !hasAuthScope(auth, 'files:write:any')
    ) {
      return res.status(403).json({ error: 'Cannot upload on behalf of another user' });
    }

    const uploaderId = auth.userId ?? providedUserId;

    if (!req.files || !Array.isArray(req.files)) {
      return res.status(400).json({ error: 'No files provided' });
    }

    const pageId = typeof req.body?.pageId === 'string' ? req.body.pageId : undefined;
    if (resourcePageId && pageId && resourcePageId !== pageId) {
      return res.status(403).json({ error: 'Token resource does not match requested page' });
    }
    const results = [];

    // Track temp files for cleanup - verify each is within expected directory
    const resolvedUploadDir = path.resolve(TEMP_UPLOADS_DIR) + path.sep;
    for (const file of req.files) {
      const normalizedPath = path.resolve(file.path);
      if (!normalizedPath.startsWith(resolvedUploadDir)) {
        return res.status(400).json({ error: 'Invalid upload file path' });
      }
      tempFilePaths.push(file.path);
    }

    for (const file of req.files) {
      const { path: tempPath, originalname, size } = file;

      try {
        const detected = await detectContentType(tempPath);
        if (DENIED_LABELS.has(detected.label)) {
          try {
            await fs.unlink(tempPath);
          } catch (cleanupError) {
            processorLogger.warn('Failed to clean up temp upload after denylist rejection', {
              tempPath,
              error: cleanupError instanceof Error ? cleanupError.message : cleanupError
            });
          }
          const idx = tempFilePaths.indexOf(tempPath);
          if (idx >= 0) tempFilePaths.splice(idx, 1);
          results.push({
            originalname,
            error: 'Unsupported file type',
            detectedLabel: detected.label,
            success: false
          });
          continue;
        }

        const verifiedMimeType = detected.mimeType;
        const detectedLabel = detected.label;

        // Calculate content hash from file
        const contentHash = await computeFileHash(tempPath);

        // Check for deduplication
        const alreadyStored = await contentStore.originalExists(contentHash);

        if (!alreadyStored) {
          await contentStore.saveOriginalFromFile(tempPath, originalname, contentHash, {
            tenantId: auth.userId,
            driveId,
            userId: uploaderId,
            service: 'processor'
          });
        }
        if (alreadyStored) {
          await contentStore.appendUploadMetadata(contentHash, {
            tenantId: auth.userId,
            driveId,
            userId: uploaderId,
            service: 'processor'
          });
        }

        // Queue processing jobs
        const jobs = await queueProcessingJobs(
          contentHash,
          originalname,
          verifiedMimeType,
          pageId,
          detectedLabel
        );

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

  /* c8 ignore next 22 */
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

// Helper function to queue appropriate processing jobs (unified ingestion)
async function queueProcessingJobs(
  contentHash: string,
  originalName: string,
  mimeType: string,
  pageId?: string,
  detectedLabel?: string
): Promise<string[]> {
  const jobIds: string[] = [];
  const jobId = await queueManager.addJob('ingest-file', {
    contentHash,
    fileId: pageId,
    mimeType,
    originalName,
    detectedLabel
  });
  jobIds.push(jobId);
  return jobIds;
}

export const uploadRouter: ExpressRouter = router;

async function computeFileHash(filePath: string): Promise<string> {
  // Verify file path is within expected upload directory
  // TEMP_UPLOADS_DIR is guaranteed non-null by module-level guard (line 19-21)
  const normalizedPath = path.resolve(filePath);
  /* c8 ignore next 3 */
  if (!normalizedPath.startsWith(path.resolve(TEMP_UPLOADS_DIR!) + path.sep)) {
    throw new Error('File path outside expected upload directory');
  }

  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath);

    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
