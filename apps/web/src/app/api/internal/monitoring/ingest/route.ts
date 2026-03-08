import { NextResponse } from 'next/server';
import { createId } from '@paralleldrive/cuid2';
import { db, systemLogs } from '@pagespace/db';
import { writeApiMetrics, writeError } from '@pagespace/lib/logger-database';
import { loggers } from '@pagespace/lib/server';
import { secureCompare } from '@pagespace/lib';
import { sanitizeIngestPayload, type IngestPayload } from '@/lib/monitoring/ingest-sanitizer';

function unauthorized(message: string, status: number = 401) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: Request) {
  const isDisabled = process.env.MONITORING_INGEST_DISABLED === 'true';
  if (isDisabled) {
    return NextResponse.json({ error: 'Monitoring ingest explicitly disabled' }, { status: 404 });
  }

  const ingestKey = process.env.MONITORING_INGEST_KEY;
  if (!ingestKey) {
    loggers.system.warn(
      'MONITORING_INGEST_KEY is not configured. ' +
      'Monitoring ingest cannot authenticate requests. ' +
      'Set MONITORING_INGEST_KEY to enable or MONITORING_INGEST_DISABLED=true to opt out.'
    );
    return NextResponse.json({ error: 'Monitoring ingest not configured' }, { status: 503 });
  }

  const providedKey = request.headers.get('x-monitoring-ingest-key');
  // Use timing-safe comparison to prevent timing attacks
  if (!providedKey || !secureCompare(providedKey, ingestKey)) {
    return unauthorized('Unauthorized');
  }

  let rawPayload: IngestPayload;
  try {
    rawPayload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  if (rawPayload.type !== 'api-request') {
    return NextResponse.json({ error: 'Unsupported payload type' }, { status: 400 });
  }

  const payload = sanitizeIngestPayload(rawPayload);

  const timestamp = payload.timestamp ? new Date(payload.timestamp) : new Date();
  type HttpMethod = NonNullable<(typeof systemLogs.$inferInsert)['method']>;
  type SystemLogLevel = (typeof systemLogs.$inferInsert)['level'];

  const method = payload.method.toUpperCase() as HttpMethod;
  const statusCode = payload.statusCode;
  const level = (statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info') as SystemLogLevel;

  try {
    await writeApiMetrics({
      endpoint: payload.endpoint,
      method,
      statusCode,
      duration: payload.duration,
      requestSize: payload.requestSize,
      responseSize: payload.responseSize,
      userId: payload.userId,
      sessionId: payload.sessionId,
      ip: payload.ip,
      userAgent: payload.userAgent,
      error: payload.error,
      requestId: payload.requestId,
      cacheHit: payload.cacheHit,
      cacheKey: payload.cacheKey,
      timestamp,
    });

    await db.insert(systemLogs).values({
      id: createId(),
      timestamp,
      level,
      message:
        payload.message || `${method} ${payload.endpoint} ${statusCode} ${payload.duration}ms`,
      category: 'api',
      userId: payload.userId,
      sessionId: payload.sessionId,
      requestId: payload.requestId,
      driveId: payload.driveId,
      pageId: payload.pageId,
      endpoint: payload.endpoint,
      method,
      ip: payload.ip,
      userAgent: payload.userAgent,
      duration: payload.duration,
      metadata: {
        ...payload.metadata,
        statusCode,
        requestSize: payload.requestSize,
        responseSize: payload.responseSize,
      },
    });

    if (payload.error) {
      await writeError({
        name: payload.errorName || 'RequestError',
        message: payload.error,
        stack: payload.errorStack,
        userId: payload.userId,
        sessionId: payload.sessionId,
        requestId: payload.requestId,
        endpoint: payload.endpoint,
        method,
        ip: payload.ip,
        userAgent: payload.userAgent,
        metadata: {
          ...payload.metadata,
          statusCode,
          duration: payload.duration,
        },
      });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    loggers.api.error('Failed to ingest monitoring payload', error as Error, {
      endpoint: payload.endpoint,
      statusCode,
    });
    return NextResponse.json({ error: 'Failed to store monitoring data' }, { status: 500 });
  }
}
