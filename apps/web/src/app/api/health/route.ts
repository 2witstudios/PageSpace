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

const checkDatabase = async (): Promise<boolean> => {
  try {
    await db.execute(sql`SELECT 1`);
    return true;
  } catch {
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

    const statusCode = isHealthy ? 200 : 503;

    return Response.json(response, {
      status: statusCode,
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    });
  } catch (error) {
    loggers.api.error('Health check failed', error as Error);

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
      status: 503,
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    });
  }
}
