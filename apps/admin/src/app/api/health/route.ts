import { db, getPoolStats } from '@pagespace/db/db';
import { sql } from '@pagespace/db/operators';

export async function GET(): Promise<Response> {
  let dbHealthy = false;
  try {
    await db.execute(sql`SELECT 1`);
    dbHealthy = true;
  } catch {
    // db unreachable
  }

  const mem = process.memoryUsage();
  const body = {
    status: dbHealthy ? 'healthy' : 'degraded',
    service: 'pagespace-admin',
    timestamp: new Date().toISOString(),
    checks: { database: dbHealthy ? 'connected' : 'disconnected' },
    memory: {
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
    },
    pool: getPoolStats(),
  };

  return Response.json(body, {
    status: 200,
    headers: { 'Cache-Control': 'no-store' },
  });
}
