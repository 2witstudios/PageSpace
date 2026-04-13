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
import { loadSiemConfig, AUDIT_LOG_SOURCES, type AuditLogSource } from './services/siem-adapter';
import { getPoolForWorker } from './db';

const AUDIT_LOG_SOURCE_SET: ReadonlySet<string> = new Set(AUDIT_LOG_SOURCES);

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

// SIEM cursor cache — refreshed in the background so /health never blocks on DB
let siemCursorCache: { lastDeliveredAt: string | null; lastError: string | null; deliveryCount: number } | null = null;
const SIEM_CACHE_TTL_MS = 15_000; // 15 seconds
let siemCacheLastRefresh = 0;

export async function refreshSiemCursorCache(): Promise<void> {
  try {
    const pool = getPoolForWorker();
    const client = await pool.connect();
    try {
      const result = await client.query(
        'SELECT "lastDeliveredAt", "lastError", "deliveryCount" FROM siem_delivery_cursors WHERE id = $1',
        ['activity_logs']
      );
      if (result.rows.length > 0) {
        const row = result.rows[0] as Record<string, unknown>;
        siemCursorCache = {
          lastDeliveredAt: row.lastDeliveredAt ? String(row.lastDeliveredAt) : null,
          lastError: (row.lastError as string | null) ?? null,
          deliveryCount: (row.deliveryCount as number) ?? 0,
        };
      } else {
        siemCursorCache = null;
      }
    } finally {
      client.release();
    }
    siemCacheLastRefresh = Date.now();
  } catch (err) {
    console.debug('[health] SIEM cursor refresh failed (table may not exist yet):', err instanceof Error ? err.message : err);
  }
}

// Health check — serves cached SIEM status to avoid blocking liveness probes on DB
app.get('/health', async (req, res) => {
  const siemConfig = loadSiemConfig();

  // Trigger a non-blocking background refresh if cache is stale
  if (siemConfig.enabled && Date.now() - siemCacheLastRefresh > SIEM_CACHE_TTL_MS) {
    refreshSiemCursorCache().catch(() => undefined);
  }

  res.json({
    status: 'healthy',
    service: 'processor',
    timestamp: new Date().toISOString(),
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
      rss: Math.round(process.memoryUsage().rss / 1024 / 1024)
    },
    siem: {
      enabled: siemConfig.enabled,
      type: siemConfig.type,
      ...(siemCursorCache && { cursor: siemCursorCache }),
    },
  });
});

// API Routes
app.use('/api/upload', authenticateService, requireScope('files:write'), uploadRouter);
app.use('/api/optimize', authenticateService, requireScope('files:optimize'), requireResourceBinding('body'), imageRouter);
app.use('/api/ingest', authenticateService, requireScope('files:ingest'), requirePageBinding(), ingestRouter);
app.use('/api/avatar', authenticateService, requireScope('avatars:write'), avatarRouter);
app.use('/api/files', authenticateService, requireScope('files:delete'), deleteFileRouter);
app.use('/cache', authenticateService, requireScope('files:read'), requireResourceBinding('params'), cacheRouter);

// ---------------------------------------------------------------------------
// SIEM receipts query endpoint
//
// Forensic "did event X ship?" lookup against siem_delivery_receipts. Returns
// deliveryId, ack state, and webhook status for any receipt whose [first,last]
// timestamp range covers the queried entry — info-disclosure surface, so it
// requires the same authenticateService + requireScope pipeline every other
// processor route uses.
//
// The new `siem:read` scope must be granted on the service token before this
// endpoint can be called.
// ---------------------------------------------------------------------------

/**
 * Two literal parameterized statements, one per source. No template-string
 * interpolation of table names — a future bug that loosens the whitelist
 * cannot become a SQLi vector because there is no SQL-builder path to abuse.
 */
async function fetchEntryTimestamp(
  client: { query: (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  source: AuditLogSource,
  entryId: string,
): Promise<Date | string | null> {
  const result = source === 'activity_logs'
    ? await client.query('SELECT timestamp AS ts FROM activity_logs WHERE id = $1 LIMIT 1', [entryId])
    : await client.query('SELECT timestamp AS ts FROM security_audit_log WHERE id = $1 LIMIT 1', [entryId]);

  if (result.rows.length === 0) return null;
  return (result.rows[0] as { ts: Date | string }).ts;
}

app.get('/siem/receipts', authenticateService, requireScope('siem:read'), async (req, res) => {
  const source = typeof req.query.source === 'string' ? req.query.source : '';
  const entryId = typeof req.query.entryId === 'string' ? req.query.entryId : '';

  if (!entryId) {
    return res.status(400).json({ error: 'entryId query parameter is required' });
  }
  if (!AUDIT_LOG_SOURCE_SET.has(source)) {
    return res.status(400).json({ error: `source must be one of: ${AUDIT_LOG_SOURCES.join(', ')}` });
  }

  const sourceKey = source as AuditLogSource;

  try {
    const pool = getPoolForWorker();
    const client = await pool.connect();
    try {
      // Two-stage lookup: resolve the entry's timestamp from its own source
      // table (literal-switch SQL — no template interpolation), then find
      // receipts whose [first, last] range covers it.
      const entryTs = await fetchEntryTimestamp(client, sourceKey, entryId);

      if (entryTs === null) {
        return res.status(200).json({ entryId, source: sourceKey, receipts: [] });
      }

      const receiptsResult = await client.query(
        `SELECT "deliveryId", "source", "deliveredAt", "webhookStatus", "ackReceivedAt", "entryCount"
         FROM siem_delivery_receipts
         WHERE "source" = $1
           AND "firstEntryTimestamp" <= $2
           AND "lastEntryTimestamp"  >= $2
         ORDER BY "deliveredAt" DESC
         LIMIT 10`,
        [sourceKey, entryTs]
      );

      const receipts = receiptsResult.rows.map((row) => {
        const r = row as Record<string, unknown>;
        const deliveredAt = r.deliveredAt instanceof Date ? r.deliveredAt : new Date(String(r.deliveredAt));
        const ackReceivedAt = r.ackReceivedAt
          ? (r.ackReceivedAt instanceof Date ? r.ackReceivedAt : new Date(String(r.ackReceivedAt)))
          : null;
        return {
          deliveryId: r.deliveryId as string,
          source: r.source as AuditLogSource,
          deliveredAt: deliveredAt.toISOString(),
          webhookStatus: (r.webhookStatus as number | null) ?? null,
          ackReceivedAt: ackReceivedAt ? ackReceivedAt.toISOString() : null,
          entryCount: r.entryCount as number,
        };
      });

      return res.status(200).json({ entryId, source: sourceKey, receipts });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[siem-receipts] Query failed:', err instanceof Error ? err.message : err);
    return res.status(500).json({ error: 'Failed to query SIEM receipts' });
  }
});

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

// Default-deny catch-all for protected routes
// Any request to /api/*, /cache/*, or /siem/* that wasn't matched by an
// explicit route above MUST be rejected to prevent authorization bypass on
// unrecognized endpoints.
app.use('/api', authenticateService, (req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});
app.use('/cache', authenticateService, (req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});
app.use('/siem', authenticateService, (req, res) => {
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
