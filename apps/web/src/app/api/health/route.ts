import { db, getPoolStats } from '@pagespace/db/db'
import { sql } from '@pagespace/db/operators';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { getMonitoringIngestStatus } from '@/middleware/monitoring';

interface HealthResponse {
  status: 'healthy' | 'degraded';
  service: string;
  version: string;
  timestamp: string;
  checks: {
    database: 'connected' | 'disconnected';
    monitoring: 'active' | 'disabled' | 'misconfigured';
  };
  memory: {
    heapUsed: number;
    heapTotal: number;
    rss: number;
  };
  pool: {
    total: number;
    idle: number;
    waiting: number;
  };
  warnings?: string[];
  error?: string;
}

// Fly's health check has no failure-count threshold of its own — a single failed
// probe right after the grace period elapses is enough to fail a rolling deploy.
// Require this many CONSECUTIVE failures before reporting unhealthy over HTTP, so
// one transient blip (e.g. a slow DB reconnect) doesn't flip the check.
const CONSECUTIVE_FAILURE_THRESHOLD = 3;
let consecutiveDbFailures = 0;

const checkDatabase = async (): Promise<boolean> => {
  try {
    await db.execute(sql`SELECT 1`);
    consecutiveDbFailures = 0;
    return true;
  } catch {
    consecutiveDbFailures += 1;
    return false;
  }
};

export async function GET(_request: Request): Promise<Response> {
  const startTime = Date.now();

  try {
    const dbHealthy = await checkDatabase();
    const monitoringStatus = getMonitoringIngestStatus();
    const memoryUsage = process.memoryUsage();
    const warnings: string[] = [];

    if (monitoringStatus === 'misconfigured') {
      warnings.push(
        'MONITORING_INGEST_KEY is not set and MONITORING_INGEST_DISABLED is not true. ' +
        'Monitoring is silently degraded.'
      );
    }

    const isHealthy = dbHealthy && monitoringStatus !== 'misconfigured';

    const response: HealthResponse = {
      status: isHealthy ? 'healthy' : 'degraded',
      service: 'pagespace-web',
      version: process.env.npm_package_version || '0.0.0',
      timestamp: new Date().toISOString(),
      checks: {
        database: dbHealthy ? 'connected' : 'disconnected',
        monitoring: monitoringStatus,
      },
      memory: {
        heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024),
        heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024),
        rss: Math.round(memoryUsage.rss / 1024 / 1024),
      },
      pool: getPoolStats(),
    };

    if (warnings.length > 0) {
      response.warnings = warnings;
    }

    if (!dbHealthy) {
      response.error = 'Database connectivity check failed';
      loggers.api.warn('Health check degraded: database disconnected', {
        duration: Date.now() - startTime,
      });
    }

    if (monitoringStatus === 'misconfigured') {
      loggers.api.warn('Health check degraded: monitoring ingest misconfigured', {
        duration: Date.now() - startTime,
      });
    }

    // Only fail the HTTP status on a sustained DB outage, not monitoring
    // misconfiguration — the latter is a config warning, not a traffic-serving
    // failure, and shouldn't cause Fly to cycle machines over it.
    const dbSustainedFailure = consecutiveDbFailures >= CONSECUTIVE_FAILURE_THRESHOLD;

    return Response.json(response, {
      status: dbSustainedFailure ? 503 : 200,
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    });
  } catch (error) {
    loggers.api.error('Health check failed', error as Error);
    consecutiveDbFailures += 1;

    const response: HealthResponse = {
      status: 'degraded',
      service: 'pagespace-web',
      version: process.env.npm_package_version || '0.0.0',
      timestamp: new Date().toISOString(),
      checks: {
        database: 'disconnected',
        monitoring: getMonitoringIngestStatus(),
      },
      memory: {
        heapUsed: 0,
        heapTotal: 0,
        rss: 0,
      },
      pool: getPoolStats(),
      error: 'Health check failed unexpectedly',
    };

    return Response.json(response, {
      status: consecutiveDbFailures >= CONSECUTIVE_FAILURE_THRESHOLD ? 503 : 200,
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    });
  }
}
