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
import { requireResourceBinding, requirePageBinding } from './middleware/resource-binding';
import { validateCorsOrigin } from './utils/cors-validation';
import { loadSiemConfig } from './services/siem-adapter';
import { SIEM_SOURCES, CURSOR_INIT_SENTINEL } from './services/siem-sources';
import { buildSiemHealth, type SiemHealthResponse } from './services/siem-health-builder';
import { readCursorSnapshots } from './workers/siem-cursor-reader';
import { readRecentReceipts } from './workers/siem-receipt-reader';
import { getPoolForWorker } from './db';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3003;

// Initialize content store
const CACHE_PATH = process.env.CACHE_PATH || '/data/cache';
const FILE_STORAGE_PATH = process.env.FILE_STORAGE_PATH || '/data/files';

export const contentStore = new ContentStore(CACHE_PATH, FILE_STORAGE_PATH);
export const queueManager = new QueueManager();

// CORS configuration
const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    const result = validateCorsOrigin(origin);
    callback(result.error, result.allowed);
  },
  credentials: true,
};

// Middleware
app.use(cors(corsOptions));
app.use(express.json({ limit: '50mb' }));

// SIEM health cache — refreshed in the background so /health never blocks on DB
type SiemHealthCache = SiemHealthResponse & { error?: string };
let siemHealthCache: SiemHealthCache | null = null;
const SIEM_CACHE_TTL_MS = 15_000; // 15 seconds
let siemCacheLastRefresh = 0;
// In-flight guard: N concurrent /health hits during a slow refresh collapse to
// one DB round trip instead of stampeding the pool.
let siemRefreshInFlight: Promise<void> | null = null;

export function refreshSiemCursorCache(): Promise<void> {
  if (siemRefreshInFlight) return siemRefreshInFlight;
  siemRefreshInFlight = doRefreshSiemCursorCache().finally(() => {
    siemRefreshInFlight = null;
  });
  return siemRefreshInFlight;
}

async function doRefreshSiemCursorCache(): Promise<void> {
  const config = loadSiemConfig();

  if (!config.enabled) {
    siemHealthCache = buildSiemHealth({
      enabled: false,
      type: null,
      sources: SIEM_SOURCES,
      cursors: [],
      recentReceipts: null,
      cursorInitSentinel: CURSOR_INIT_SENTINEL,
    });
    siemCacheLastRefresh = Date.now();
    return;
  }

  try {
    const pool = getPoolForWorker();
    const client = await pool.connect();
    try {
      // allSettled so a transient failure in the optional receipts read does
      // not wipe the primary cursor status that operators rely on.
      const [cursorsResult, receiptsResult] = await Promise.allSettled([
        readCursorSnapshots(client, SIEM_SOURCES),
        readRecentReceipts(client),
      ]);

      if (cursorsResult.status === 'rejected') {
        throw cursorsResult.reason;
      }

      let recentReceipts: Awaited<ReturnType<typeof readRecentReceipts>>;
      if (receiptsResult.status === 'rejected') {
        const message =
          receiptsResult.reason instanceof Error
            ? receiptsResult.reason.message
            : String(receiptsResult.reason);
        console.warn('[health] SIEM receipts read failed, omitting lastReceipt:', message);
        recentReceipts = null;
      } else {
        recentReceipts = receiptsResult.value;
      }

      siemHealthCache = buildSiemHealth({
        enabled: true,
        type: config.type,
        sources: SIEM_SOURCES,
        cursors: cursorsResult.value,
        recentReceipts,
        cursorInitSentinel: CURSOR_INIT_SENTINEL,
      });
    } finally {
      client.release();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[health] SIEM cursor refresh failed:', message);
    // Surface a degraded-but-200 response so k8s liveness probes don't flap
    // on a transient DB blip inside the SIEM subsystem.
    siemHealthCache = {
      enabled: true,
      type: config.type,
      sources: {},
      error: 'health check db error',
    };
  }

  siemCacheLastRefresh = Date.now();
}

// Health check — serves cached SIEM status to avoid blocking liveness probes on DB
app.get('/health', async (req, res) => {
  const siemConfig = loadSiemConfig();

  // Trigger a non-blocking background refresh if cache is stale. The in-flight
  // guard inside refreshSiemCursorCache coalesces concurrent triggers.
  if (Date.now() - siemCacheLastRefresh > SIEM_CACHE_TTL_MS) {
    refreshSiemCursorCache().catch(() => undefined);
  }

  const siem: SiemHealthCache = siemHealthCache ?? {
    enabled: siemConfig.enabled,
    type: siemConfig.enabled ? siemConfig.type : null,
    sources: {},
  };

  res.json({
    status: 'healthy',
    service: 'processor',
    timestamp: new Date().toISOString(),
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
      rss: Math.round(process.memoryUsage().rss / 1024 / 1024)
    },
    siem,
  });
});

// API Routes
app.use('/api/upload', authenticateService, requireScope('files:write'), uploadRouter);
app.use('/api/optimize', authenticateService, requireScope('files:optimize'), requireResourceBinding('body'), imageRouter);
app.use('/api/ingest', authenticateService, requireScope('files:ingest'), requirePageBinding(), ingestRouter);
app.use('/api/avatar', authenticateService, requireScope('avatars:write'), avatarRouter);
app.use('/api/files', authenticateService, requireScope('files:delete'), deleteFileRouter);
app.use('/cache', authenticateService, requireScope('files:read'), requireResourceBinding('params'), cacheRouter);

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
