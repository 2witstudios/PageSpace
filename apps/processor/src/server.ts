import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import { ContentStore } from './cache/content-store';
import { imageRouter } from './api/optimize';
import { uploadRouter } from './api/upload';
import { cacheRouter } from './api/serve';
import { QueueManager } from './workers/queue-manager';
import { ingestRouter } from './api/ingest';
import avatarRouter from './api/avatar';
import { deleteFileRouter } from './api/delete-file';
import dotenv from 'dotenv';
import { authenticateService, requireScope } from './middleware/auth';
import { loggers } from '@pagespace/lib/logger-config';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3003;

// Initialize content store
const CACHE_PATH = process.env.CACHE_PATH || '/data/cache';
const FILE_STORAGE_PATH = process.env.FILE_STORAGE_PATH || '/data/files';

export const contentStore = new ContentStore(CACHE_PATH, FILE_STORAGE_PATH);
export const queueManager = new QueueManager();

// Origin normalization (consistent URL comparison)
function normalizeOrigin(origin: string): string {
  try {
    return new URL(origin).origin;
  } catch {
    return '';
  }
}

// Build allowed origins list from environment
function getAllowedOrigins(): string[] {
  const origins: string[] = [];

  const corsOrigin = process.env.CORS_ORIGIN;
  const webAppUrl = process.env.WEB_APP_URL;

  if (corsOrigin) {
    const normalized = normalizeOrigin(corsOrigin);
    if (normalized) origins.push(normalized);
  } else if (webAppUrl) {
    const normalized = normalizeOrigin(webAppUrl);
    if (normalized) origins.push(normalized);
  }

  const additional = process.env.ADDITIONAL_ALLOWED_ORIGINS;
  if (additional) {
    origins.push(
      ...additional
        .split(',')
        .map((o) => normalizeOrigin(o.trim()))
        .filter((o) => o.length > 0)
    );
  }

  return origins;
}

// CORS configuration
const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    // No origin = non-browser client (curl, MCP, mobile) - allow
    if (!origin) {
      return callback(null, true);
    }

    const allowedOrigins = getAllowedOrigins();

    // No config in production = fail closed
    if (allowedOrigins.length === 0) {
      const isProduction = process.env.NODE_ENV === 'production';
      if (isProduction) {
        loggers.processor.error('CORS rejected: no allowed origins configured', {
          origin,
          severity: 'security',
        });
        return callback(new Error('CORS not configured'), false);
      }
      loggers.processor.warn('CORS: no allowed origins configured (allowing in dev)', { origin });
      return callback(null, true);
    }

    // Check origin against allowed list
    const normalized = normalizeOrigin(origin);
    if (allowedOrigins.includes(normalized)) {
      return callback(null, true);
    }

    // Reject unknown origin
    loggers.processor.warn('CORS rejected: origin not in allowed list', {
      origin,
      allowedOrigins,
      severity: 'security',
    });
    callback(new Error('Origin not allowed'), false);
  },
  credentials: true,
};

// Middleware
app.use(cors(corsOptions));
app.use(express.json({ limit: '50mb' }));

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'processor',
    timestamp: new Date().toISOString(),
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
      rss: Math.round(process.memoryUsage().rss / 1024 / 1024)
    }
  });
});

// API Routes
app.use('/api/upload', authenticateService, requireScope('files:write'), uploadRouter);
app.use('/api/optimize', authenticateService, requireScope('files:optimize'), imageRouter);
app.use('/api/ingest', authenticateService, requireScope('files:ingest'), ingestRouter);
app.use('/api/avatar', authenticateService, requireScope('avatars:write'), avatarRouter);
app.use('/api/files', authenticateService, requireScope('files:delete'), deleteFileRouter);
app.use('/cache', authenticateService, requireScope('files:read'), cacheRouter);

// Queue status endpoint
app.get(
  '/api/queue/status',
  authenticateService,
  requireScope('queue:read'),
  async (req, res) => {
    try {
      const status = await queueManager.getQueueStatus();
      res.json(status);
    } catch (error) {
      res.status(500).json({ error: 'Failed to get queue status' });
    }
  }
);

// Job status endpoint
app.get(
  '/api/job/:jobId',
  authenticateService,
  requireScope('queue:read'),
  async (req, res) => {
    try {
      const job = await queueManager.getJob(req.params.jobId);
      if (!job) {
        return res.status(404).json({ error: 'Job not found' });
      }
      res.json(job);
    } catch (error) {
      res.status(500).json({ error: 'Failed to get job status' });
    }
  }
);

// Default-deny catch-all for protected API routes
// Any request to /api/* or /cache/* that wasn't matched by explicit routes above
// MUST be rejected to prevent authorization bypass on unrecognized endpoints
app.use('/api', authenticateService, (req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});
app.use('/cache', authenticateService, (req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Error handling
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// Initialize and start server
async function start() {
  try {
    // Initialize content store
    await contentStore.initialize();
    console.log('✓ Content store initialized');

    // Initialize queue manager
    await queueManager.initialize();
    console.log('✓ Queue manager initialized');

    // Start server
    app.listen(PORT, () => {
      console.log(`🚀 Processor service running on port ${PORT}`);
      console.log(`📁 Cache path: ${CACHE_PATH}`);
      console.log(`📁 Storage path: ${FILE_STORAGE_PATH}`);
      console.log(`💾 Memory limit: ${process.env.NODE_OPTIONS || 'default'}`);
    });

    // Cleanup old cache periodically (every hour)
    setInterval(async () => {
      try {
        const deleted = await contentStore.cleanupOldCache();
        if (deleted > 0) {
          console.log(`🧹 Cleaned up ${deleted} old cache entries`);
        }
      } catch (error) {
        console.error('Cache cleanup error:', error);
      }
    }, 60 * 60 * 1000);

    // Graceful shutdown
    process.on('SIGTERM', async () => {
      console.log('SIGTERM received, shutting down gracefully...');
      await queueManager.shutdown();
      process.exit(0);
    });

  } catch (error) {
    console.error('Failed to start processor service:', error);
    process.exit(1);
  }
}

start();
