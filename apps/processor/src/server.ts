import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import { ContentStore } from './cache/content-store';
import { createS3Client, getS3Bucket } from './s3-client';
import { imageRouter } from './api/optimize';
import { cacheRouter } from './api/serve';
import { QueueManager } from './workers/queue-manager';
import { ingestRouter } from './api/ingest';
import { verifyRouter } from './api/verify';
import avatarRouter from './api/avatar';
import { deleteFileRouter } from './api/delete-file';
import { erasureRouter } from './api/erasure';
import dotenv from 'dotenv';
import { authenticateService, requireScope } from './middleware/auth';
import { requireResourceBinding, requirePageBinding } from './middleware/resource-binding';
import { validateCorsOrigin } from './utils/cors-validation';
import { loadSiemConfig, type AuditLogSource } from './services/siem-adapter';
import { probeClickHouseStartup } from '@pagespace/lib/observability/clickhouse-client';
import { drainAnalyticsInserts } from '@pagespace/lib/observability/analytics-inserts';
import { SIEM_SOURCES, CURSOR_INIT_SENTINEL } from './services/siem-sources';
import { buildSiemHealth, type SiemHealthResponse } from './services/siem-health-builder';
import { readCursorSnapshots } from './workers/siem-cursor-reader';
import { readRecentReceipts } from './workers/siem-receipt-reader';
import { resolveSiemPoolRouting, type SiemStorePlane } from './services/siem-pool-routing';
import { getPoolForWorker, getAdminPoolForWorker } from './db';

// SIEM state (cursors/receipts) moved to the Admin PG at the #890 Phase 2
// cutover; per-source data reads follow the same pool-per-operation matrix
// the delivery worker uses (services/siem-pool-routing.ts). In break-glass
// everything reverts to main. In 'fail' mode we still serve the main-db
// (legacy) state rather than erroring: /health is a liveness surface and the
// worker itself already logs the misconfiguration loudly.
function siemPoolFor(plane: SiemStorePlane | undefined) {
  return plane === 'admin' ? getAdminPoolForWorker() : getPoolForWorker();
}

function siemRouting() {
  return resolveSiemPoolRouting({
    ADMIN_DATABASE_URL: process.env.ADMIN_DATABASE_URL,
    ADMIN_DB_BREAK_GLASS: process.env.ADMIN_DB_BREAK_GLASS,
  }).routing;
}

// Whitelist for the /siem/receipts endpoint, derived from the canonical
// SIEM_SOURCES list so a third source added there cannot silently bypass
// validation here.
const SIEM_SOURCE_SET: ReadonlySet<string> = new Set(SIEM_SOURCES);

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3003;

export const contentStore = new ContentStore(createS3Client(), getS3Bucket());
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
    // Cursors and receipts share the SIEM state plane, so one client covers
    // both reads.
    const pool = siemPoolFor(siemRouting()?.cursors);
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
app.use('/api/optimize', authenticateService, requireScope('files:optimize'), requireResourceBinding('body'), imageRouter);
app.use('/api/ingest', authenticateService, requireScope('files:ingest'), requirePageBinding(), ingestRouter);
// Attachment byte-verify (channel/DM direct-to-S3). NOT page-bound — accepts a
// conversation- or page-bound files:write token; the handler validates the binding
// and re-hashes the stored object supplied by the trusted web service.
app.use('/api/verify', authenticateService, requireScope('files:write'), verifyRouter);
app.use('/api/avatar', authenticateService, requireScope('avatars:write'), avatarRouter);
// Public avatar reads — no auth required; avatars are public images.
// Web app proxies GET /api/avatar/:userId/:filename here when it doesn't have
// direct volume access (e.g. Fly.io deployments).
app.use('/avatars', avatarRouter);
app.use('/api/files', authenticateService, requireScope('files:delete'), deleteFileRouter);
app.use('/api/erasure', authenticateService, requireScope('erasure:enqueue'), erasureRouter);
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
  if (!SIEM_SOURCE_SET.has(source)) {
    return res.status(400).json({ error: `source must be one of: ${SIEM_SOURCES.join(', ')}` });
  }

  const sourceKey = source as AuditLogSource;

  try {
    // The entry's timestamp lives in its SOURCE table (per-source plane:
    // security_audit_log is in the Admin PG post-cutover, activity_logs on
    // main until Phase 5); the receipts live in the SIEM state plane. Reuse
    // one client when both resolve to the same pool (break-glass, or a
    // security-source lookup in dedicated mode).
    const routing = siemRouting();
    const dataPlane: SiemStorePlane = routing?.data[sourceKey] ?? 'main';
    const receiptsPlane: SiemStorePlane = routing?.receipts ?? 'main';
    const dataPool = siemPoolFor(dataPlane);
    const client = await dataPool.connect();
    const receiptsClient =
      receiptsPlane === dataPlane ? client : await siemPoolFor(receiptsPlane).connect();
    try {
      // Two-stage lookup: resolve the entry's timestamp from its own source
      // table (literal-switch SQL — no template interpolation), then find
      // receipts whose [first, last] range covers it.
      const entryTs = await fetchEntryTimestamp(client, sourceKey, entryId);

      if (entryTs === null) {
        return res.status(200).json({ entryId, source: sourceKey, receipts: [] });
      }

      const receiptsResult = await receiptsClient.query(
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
      if (receiptsClient !== client) {
        receiptsClient.release();
      }
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
app.get<{ jobId: string }>(
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
    // Fail-fast: a half-configured ClickHouse deploy (flag on, creds missing)
    // must crash here — the insert adapters absorb per-row errors by design,
    // so a running process would silently drop all 4 analytics tables'
    // telemetry (#890 Phase 3). Throws into the catch below → process.exit(1).
    const chMode = probeClickHouseStartup();
    console.log(`✓ ClickHouse analytics tier: ${chMode.mode}`);

    // Initialize content store
    await contentStore.initialize();
    console.log('✓ Content store initialized');

    // Initialize queue manager
    await queueManager.initialize();
    console.log('✓ Queue manager initialized');

    // Start server
    app.listen(PORT, () => {
      console.log(`🚀 Processor service running on port ${PORT}`);
      console.log(`☁️  Storage: S3 bucket=${getS3Bucket()}`);
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

    // Graceful shutdown: drain the CH insert buffers first (workers write
    // analytics rows through them — up to 500 rows/table sit in memory),
    // then stop the queue manager.
    let shuttingDown = false;
    const shutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`${signal} received, shutting down gracefully...`);
      // Each step is guarded so a rejection can never skip process.exit(0) —
      // otherwise the process would hang until the runtime SIGKILLs it (mirrors
      // the per-step guards in packages/lib graceful-shutdown.ts).
      try {
        await drainAnalyticsInserts();
      } catch (error) {
        console.error('Analytics drain failed during shutdown:', error);
      }
      try {
        await queueManager.shutdown();
      } catch (error) {
        console.error('Queue manager shutdown failed:', error);
      }
      process.exit(0);
    };
    // Return the shutdown promise so callers/tests can await the full
    // drain → queue-shutdown → exit chain; Node ignores the handler's
    // return value at runtime (same fire-and-forget as an async handler).
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

  } catch (error) {
    console.error('Failed to start processor service:', error);
    process.exit(1);
  }
}

start();
