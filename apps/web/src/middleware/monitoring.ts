/**
 * Monitoring Middleware for PageSpace — edge-safe.
 *
 * Runs inside the Edge runtime (imported by src/middleware.ts), so this module
 * must never touch the database, Node built-ins, or @pagespace/lib's Node-only
 * logger. Persistence happens at the Node layer instead: every /api request is
 * forwarded as a fire-and-forget POST to /api/internal/monitoring/ingest
 * (authenticated via x-monitoring-ingest-key), whose route handler writes the
 * apiMetrics and systemLogs rows the admin dashboard reads. The old in-process
 * MetricsCollector (setInterval + direct db.insert from middleware) was
 * deleted: it was Node-only, never once ran in production, and wrote from the
 * wrong layer.
 *
 * Non-API page requests are logged to the console stream only, by design —
 * they were previously tracked only by the deleted collector.
 */

import { NextRequest, NextResponse } from 'next/server';
import type { NextFetchEvent } from 'next/server';
import { createEdgeLogger } from '@/lib/logging/edge-logger';
import {
  getOrCreateRequestId,
  REQUEST_ID_HEADER,
} from '@/lib/request-id/request-id';
import { sanitizeEndpoint } from '@/lib/monitoring/ingest-sanitizer';
import { getClientIP } from '@/lib/security/edge-client-ip';

const systemLogger = createEdgeLogger('system');
const performanceLogger = createEdgeLogger('performance');
const apiLogger = createEdgeLogger('api');

interface RequestContext {
  endpoint: string;
  method: string;
  ip: string;
  userAgent?: string;
}

/**
 * Extract logging context from the request. Local, pure equivalent of
 * @pagespace/lib logger-config's extractRequestContext (which lives in the
 * Node-only logger graph).
 */
function extractRequestContext(request: NextRequest): RequestContext {
  return {
    endpoint: request.nextUrl.pathname,
    method: request.method,
    ip: getClientIP(request),
    userAgent: request.headers.get('user-agent') || undefined,
  };
}

/**
 * Log the response line (same message format as @pagespace/lib logResponse:
 * "METHOD /endpoint STATUS DURATIONms", warn at 4xx, error at 5xx).
 */
function logResponse(
  context: RequestContext,
  statusCode: number,
  duration: number,
  metadata: Record<string, unknown>
): void {
  const message = `${context.method} ${context.endpoint} ${statusCode} ${duration}ms`;
  const fullMetadata = { ...metadata, ...context, statusCode, duration };

  if (statusCode >= 500) {
    apiLogger.error(message, undefined, fullMetadata);
  } else if (statusCode >= 400) {
    apiLogger.warn(message, fullMetadata);
  } else {
    apiLogger.info(message, fullMetadata);
  }
}

// Fields this middleware actually sends. The ingest route's IngestPayload
// (@/lib/monitoring/ingest-sanitizer) accepts a wider optional set
// (sessionId, cacheHit, driveId, …) for other producers; middleware has no
// values for those, so they are deliberately absent here.
interface MonitoringIngestPayload {
  type: 'api-request';
  requestId: string;
  timestamp: string;
  method: string;
  endpoint: string;
  statusCode: number;
  duration: number;
  requestSize?: number;
  responseSize?: number;
  userId?: string;
  ip?: string;
  userAgent?: string;
  error?: string;
  errorName?: string;
  errorStack?: string;
}

const DEFAULT_INGEST_PATH = '/api/internal/monitoring/ingest';

/**
 * Determines the monitoring ingest configuration state:
 * - 'active': MONITORING_INGEST_KEY is set, monitoring works normally
 * - 'disabled': MONITORING_INGEST_DISABLED=true, intentionally opted out
 * - 'misconfigured': key missing without explicit opt-out (silent degradation risk)
 */
export function getMonitoringIngestStatus(): 'active' | 'disabled' | 'misconfigured' {
  const isDisabled = process.env.MONITORING_INGEST_DISABLED === 'true';
  if (isDisabled) return 'disabled';
  const hasKey = Boolean(process.env.MONITORING_INGEST_KEY);
  return hasKey ? 'active' : 'misconfigured';
}

// Track whether we've warned about missing ingest key (to avoid log spam)
let hasWarnedMissingIngestKey = false;
let hasLoggedStartupStatus = false;

function logMonitoringStatus(): void {
  if (hasLoggedStartupStatus) return;
  hasLoggedStartupStatus = true;

  const status = getMonitoringIngestStatus();
  if (status === 'misconfigured') {
    const isProduction = process.env.NODE_ENV === 'production';
    const prefix = isProduction ? '[PRODUCTION WARNING]' : '[WARNING]';
    systemLogger.warn(
      `${prefix} MONITORING_INGEST_KEY is not configured and MONITORING_INGEST_DISABLED is not set. ` +
      'Monitoring ingest is silently degraded. Set MONITORING_INGEST_KEY to enable monitoring, ' +
      'or set MONITORING_INGEST_DISABLED=true to explicitly opt out.'
    );
  } else if (status === 'disabled') {
    systemLogger.info('Monitoring ingest explicitly disabled via MONITORING_INGEST_DISABLED=true');
  }
}

function queueMonitoringIngest(
  request: NextRequest,
  payload: MonitoringIngestPayload,
  event?: NextFetchEvent
): void {
  const status = getMonitoringIngestStatus();

  if (status !== 'active') {
    if (status === 'misconfigured' && !hasWarnedMissingIngestKey) {
      hasWarnedMissingIngestKey = true;
      systemLogger.warn(
        'MONITORING_INGEST_KEY is not configured; monitoring ingest is disabled. ' +
        'Set MONITORING_INGEST_KEY to enable monitoring or MONITORING_INGEST_DISABLED=true to silence this warning.'
      );
    }
    return;
  }

  const ingestKey = process.env.MONITORING_INGEST_KEY!;

  try {
    const ingestPath = process.env.MONITORING_INGEST_PATH || DEFAULT_INGEST_PATH;
    const url = new URL(ingestPath, request.nextUrl.origin);

    const forward = fetch(url.toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-monitoring-ingest-key': ingestKey,
      },
      body: JSON.stringify(payload),
      cache: 'no-store',
      keepalive: true,
    }).catch((error) => {
      performanceLogger.debug('Failed to forward monitoring payload', {
        error: (error as Error).message,
        endpoint: payload.endpoint,
      });
    });

    // Fire-and-forget is not enough on Edge: the runtime may cancel in-flight
    // work as soon as the response is returned. waitUntil() keeps this POST —
    // the ONLY persistence path for API metrics — alive until it settles.
    // (`forward` already has a .catch, so it never rejects inside waitUntil.)
    event?.waitUntil(forward);
  } catch (error) {
    performanceLogger.debug('Unable to construct monitoring ingest request', {
      error: (error as Error).message,
      endpoint: payload.endpoint,
    });
  }
}

/**
 * Extract user ID from request headers (set by main middleware)
 */
function extractUserId(request: NextRequest): string | undefined {
  const userIdHeader = request.headers.get('x-user-id');
  return userIdHeader ?? undefined;
}

/**
 * Calculate request size
 */
function getRequestSize(request: NextRequest): number {
  const contentLength = request.headers.get('content-length');
  if (contentLength) {
    return parseInt(contentLength, 10);
  }
  return 0;
}

/**
 * Calculate response size
 */
function getResponseSize(response: NextResponse): number {
  const contentLength = response.headers.get('content-length');
  if (contentLength) {
    return parseInt(contentLength, 10);
  }
  return 0;
}

// Static assets and Next.js internals to skip (module-level: this check runs
// first thing on every request).
const SKIP_PATHS = [
  '/_next',
  '/favicon.ico',
  '/robots.txt',
  '/sitemap.xml',
  '/api/internal/monitoring/ingest',
  '.js',
  '.css',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.ico',
  '.woff',
  '.woff2'
];

/**
 * Check if path should be monitored
 */
function shouldMonitor(pathname: string): boolean {
  return !SKIP_PATHS.some(path => pathname.includes(path));
}

/**
 * Main monitoring middleware.
 *
 * `event` is the NextFetchEvent Next passes to middleware; when provided, the
 * ingest POST is registered via event.waitUntil() so the Edge runtime keeps it
 * alive after the response returns (otherwise it may be cancelled in flight).
 */
export async function monitoringMiddleware(
  request: NextRequest,
  next: () => Promise<NextResponse>,
  event?: NextFetchEvent
): Promise<NextResponse> {
  // Log monitoring configuration status once on first request
  logMonitoringStatus();

  const { pathname } = request.nextUrl;

  // Skip monitoring for static assets
  if (!shouldMonitor(pathname)) {
    return next();
  }

  // Get or generate request ID (preserves incoming ID for distributed tracing)
  const requestId = getOrCreateRequestId(request);
  const startTime = Date.now();

  // Extract context
  const context = extractRequestContext(request);
  const userId = extractUserId(request);
  const cleanEndpoint = sanitizeEndpoint(pathname);
  const requestSize = getRequestSize(request);

  // Log request start
  apiLogger.info(`Request started: ${context.method} ${context.endpoint}`, {
    requestId,
    userId,
    ...context,
  });

  // Fields common to the success- and error-path ingest payloads, so a new
  // field can't be added to one path and silently missed on the other.
  const basePayload = {
    type: 'api-request' as const,
    requestId,
    timestamp: new Date(startTime).toISOString(),
    method: request.method.toUpperCase(),
    endpoint: cleanEndpoint,
    requestSize,
    userId,
    ip: context.ip,
    userAgent: context.userAgent,
  };

  try {
    // Execute the request
    const response = await next();

    // Calculate metrics
    const duration = Date.now() - startTime;
    const responseSize = getResponseSize(response);
    const statusCode = response.status;

    if (pathname.startsWith('/api')) {
      const isServerError = statusCode >= 500;
      queueMonitoringIngest(request, {
        ...basePayload,
        statusCode,
        duration,
        responseSize,
        error: isServerError ? `HTTP ${statusCode}` : undefined,
        errorName: isServerError ? 'HttpError' : undefined,
      }, event);
    }

    // Log response
    logResponse(context, statusCode, duration, {
      requestId,
      userId,
      requestSize,
      responseSize
    });

    // Log slow requests
    if (duration > 1000) {
      performanceLogger.warn(`Slow request detected: ${duration}ms`, {
        threshold: 1000,
        actual: duration,
        requestId,
        userId,
        ...context,
      });
    }

    // Add monitoring headers
    response.headers.set(REQUEST_ID_HEADER, requestId);
    response.headers.set('X-Response-Time', `${duration}ms`);

    return response;
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const errorName = error instanceof Error ? error.name : 'Error';
    const errorStack = error instanceof Error ? error.stack : undefined;

    if (pathname.startsWith('/api')) {
      queueMonitoringIngest(request, {
        ...basePayload,
        statusCode: 500,
        duration,
        responseSize: 0,
        error: errorMessage,
        errorName,
        errorStack,
      }, event);
    }

    // Log error
    apiLogger.error(
      `Request failed: ${context.method} ${context.endpoint}`,
      error instanceof Error ? error : undefined,
      { duration, requestId, userId, ...context }
    );

    // Re-throw the error
    throw error;
  }
}
