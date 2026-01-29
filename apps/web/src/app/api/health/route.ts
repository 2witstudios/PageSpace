import { db, sql } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';

interface HealthResponse {
  status: 'healthy' | 'degraded';
  service: string;
  version: string;
  timestamp: string;
  checks: {
    database: 'connected' | 'disconnected';
  };
  memory: {
    heapUsed: number;
    heapTotal: number;
    rss: number;
  };
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
    const memoryUsage = process.memoryUsage();

    const response: HealthResponse = {
      status: dbHealthy ? 'healthy' : 'degraded',
      service: 'pagespace-web',
      version: process.env.npm_package_version || '0.0.0',
      timestamp: new Date().toISOString(),
      checks: {
        database: dbHealthy ? 'connected' : 'disconnected',
      },
      memory: {
        heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024),
        heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024),
        rss: Math.round(memoryUsage.rss / 1024 / 1024),
      },
    };

    if (!dbHealthy) {
      response.error = 'Database connectivity check failed';
      loggers.api.warn('Health check degraded: database disconnected', {
        duration: Date.now() - startTime,
      });
    }

    const statusCode = dbHealthy ? 200 : 503;

    return new Response(JSON.stringify(response), {
      status: statusCode,
      headers: {
        'Content-Type': 'application/json',
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
      },
      memory: {
        heapUsed: 0,
        heapTotal: 0,
        rss: 0,
      },
      error: 'Health check failed unexpectedly',
    };

    return new Response(JSON.stringify(response), {
      status: 503,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    });
  }
}
