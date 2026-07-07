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
import { createEdgeLogger } from '@/lib/logging/edge-logger';
import {
  getOrCreateRequestId,
  REQUEST_ID_HEADER,
} from '@/lib/request-id/request-id';
import { sanitizeEndpoint } from '@/lib/monitoring/ingest-sanitizer';

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
    ip:
      request.headers.get('x-forwarded-for')?.split(',')[0] ||
      request.headers.get('x-real-ip') ||
      'unknown',
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
  sessionId?: string;
  ip?: string;
  userAgent?: string;
  error?: string;
  errorName?: string;
  errorStack?: string;
  cacheHit?: boolean;
  cacheKey?: string;
  driveId?: string;
  pageId?: string;
  metadata?: Record<string, unknown>;
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

function queueMonitoringIngest(request: NextRequest, payload: MonitoringIngestPayload): void {
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

    fetch(url.toString(), {
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
  // Estimate size from response body if available
  return 0;
}

/**
 * Check if path should be monitored
 */
function shouldMonitor(pathname: string): boolean {
  // Skip static assets and Next.js internals
  const skipPaths = [
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

  return !skipPaths.some(path => pathname.includes(path));
}

/**
 * Main monitoring middleware
 */
export async function monitoringMiddleware(
  request: NextRequest,
  next: () => Promise<NextResponse>
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
  const startedAt = new Date();
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
        type: 'api-request',
        requestId,
        timestamp: startedAt.toISOString(),
        method: request.method.toUpperCase(),
        endpoint: cleanEndpoint,
        statusCode,
        duration,
        requestSize,
        responseSize,
        userId,
        ip: context.ip,
        userAgent: context.userAgent,
        error: isServerError ? `HTTP ${statusCode}` : undefined,
        errorName: isServerError ? 'HttpError' : undefined,
      });
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
        type: 'api-request',
        requestId,
        timestamp: startedAt.toISOString(),
        method: request.method.toUpperCase(),
        endpoint: cleanEndpoint,
        statusCode: 500,
        duration,
        requestSize,
        responseSize: 0,
        userId,
        ip: context.ip,
        userAgent: context.userAgent,
        error: errorMessage,
        errorName,
        errorStack,
      });
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
