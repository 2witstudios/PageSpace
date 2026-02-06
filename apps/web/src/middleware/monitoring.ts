/**
 * Monitoring Middleware for PageSpace
 * Tracks API requests, performance, and user interactions
 */

import { NextRequest, NextResponse } from 'next/server';
import { logger, loggers, extractRequestContext, logResponse } from '@pagespace/lib/server';
import {
  getOrCreateRequestId,
  REQUEST_ID_HEADER,
} from '@/lib/request-id/request-id';
import { db, apiMetrics } from '@pagespace/db';

// In-memory buffer for metrics (flushed to database every 30s or when buffer is full)
interface RequestMetrics {
  endpoint: string;
  method: string;
  statusCode: number;
  duration: number;
  timestamp: Date;
  userId?: string;
  ip?: string;
  userAgent?: string;
  requestSize?: number;
  responseSize?: number;
  error?: string;
}

interface EndpointMetrics {
  count: number;
  avgDuration: number;
  errors: number;
}

interface MetricsSummary {
  total: number;
  errors: number;
  errorRate: number;
  avgDuration: number;
  endpoints: number;
  topEndpoints: Array<[string, EndpointMetrics]>;
}

class MetricsCollector {
  private static instance: MetricsCollector;
  private metrics: RequestMetrics[] = [];
  private readonly maxBufferSize = 1000;
  private readonly flushInterval = 30000; // 30 seconds
  private flushTimer: NodeJS.Timeout | null = null;

  private constructor() {
    this.startFlushTimer();
  }

  static getInstance(): MetricsCollector {
    if (!MetricsCollector.instance) {
      MetricsCollector.instance = new MetricsCollector();
    }
    return MetricsCollector.instance;
  }

  private startFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }

    this.flushTimer = setInterval(() => {
      this.flush();
    }, this.flushInterval);
  }

  async track(metric: RequestMetrics): Promise<void> {
    this.metrics.push(metric);
    
    if (this.metrics.length >= this.maxBufferSize) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.metrics.length === 0) return;

    const metricsToFlush = [...this.metrics];
    this.metrics = [];

    try {
      // Write metrics to database
      await db.insert(apiMetrics).values(
        metricsToFlush.map(metric => ({
          endpoint: metric.endpoint,
          method: metric.method as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS',
          statusCode: metric.statusCode,
          duration: metric.duration,
          timestamp: metric.timestamp,
          userId: metric.userId,
          ip: metric.ip,
          userAgent: metric.userAgent,
          requestSize: metric.requestSize,
          responseSize: metric.responseSize,
          error: metric.error,
        }))
      );

      // Also log summary for real-time monitoring
      const summary = this.summarizeMetrics(metricsToFlush);
      loggers.performance.info('Metrics flushed to database', {
        ...summary,
        flushedCount: metricsToFlush.length
      });
    } catch (error) {
      // If database write fails, fall back to logging only
      loggers.performance.error('Failed to write metrics to database', error as Error);
      const summary = this.summarizeMetrics(metricsToFlush);
      loggers.performance.info('Metrics flush (fallback to logs only)', summary);
    }
  }

  private summarizeMetrics(metrics: RequestMetrics[]): MetricsSummary {
    const total = metrics.length;
    const errors = metrics.filter(m => m.statusCode >= 400).length;
    const avgDuration = metrics.reduce((sum, m) => sum + m.duration, 0) / total;
    
    const byEndpoint = metrics.reduce((acc, m) => {
      const key = `${m.method} ${m.endpoint}`;
      if (!acc[key]) acc[key] = { count: 0, avgDuration: 0, errors: 0 };
      acc[key].count++;
      acc[key].avgDuration += m.duration;
      if (m.statusCode >= 400) acc[key].errors++;
      return acc;
    }, {} as Record<string, EndpointMetrics>);

    // Calculate averages
    Object.keys(byEndpoint).forEach(key => {
      byEndpoint[key].avgDuration /= byEndpoint[key].count;
    });

    return {
      total,
      errors,
      errorRate: (errors / total) * 100,
      avgDuration: Math.round(avgDuration),
      endpoints: Object.keys(byEndpoint).length,
      topEndpoints: Object.entries(byEndpoint)
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 5) as Array<[string, EndpointMetrics]>
    };
  }

  getMetrics(): RequestMetrics[] {
    return [...this.metrics];
  }
}

// Initialize metrics collector
const metricsCollector = MetricsCollector.getInstance();

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
  query?: Record<string, unknown>;
}

const DEFAULT_INGEST_PATH = '/api/internal/monitoring/ingest';

// Track whether we've warned about missing ingest key (to avoid log spam)
let hasWarnedMissingIngestKey = false;

function queueMonitoringIngest(request: NextRequest, payload: MonitoringIngestPayload): void {
  const ingestKey = process.env.MONITORING_INGEST_KEY;
  if (!ingestKey) {
    if (!hasWarnedMissingIngestKey) {
      hasWarnedMissingIngestKey = true;
      loggers.system.warn(
        'MONITORING_INGEST_KEY is not configured; monitoring ingest is disabled. ' +
        'Set MONITORING_INGEST_KEY in your environment to enable API monitoring.'
      );
    }
    return;
  }

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
      loggers.performance.debug('Failed to forward monitoring payload', {
        error: (error as Error).message,
        endpoint: payload.endpoint,
      });
    });
  } catch (error) {
    loggers.performance.debug('Unable to construct monitoring ingest request', {
      error: (error as Error).message,
      endpoint: payload.endpoint,
    });
  }
}

/**
 * Extract user ID from request headers (set by main middleware)
 */
async function extractUserId(request: NextRequest): Promise<string | undefined> {
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
  const userId = await extractUserId(request);
  
  // Create request-scoped logger
  const requestLogger = logger.child({ 
    requestId,
    userId,
    ...context
  });

  // Log request start
  requestLogger.info(`Request started: ${context.method} ${context.endpoint}`);

  try {
    // Execute the request
    const response = await next();
    
    // Calculate metrics
    const duration = Date.now() - startTime;
    const requestSize = getRequestSize(request);
    const responseSize = getResponseSize(response);
    const statusCode = response.status;

    // Track metrics
    await metricsCollector.track({
      endpoint: pathname,
      method: request.method,
      statusCode,
      duration,
      timestamp: startedAt,
      userId,
      ip: context.ip,
      userAgent: context.userAgent,
      requestSize,
      responseSize
    });

    if (pathname.startsWith('/api')) {
      const isServerError = statusCode >= 500;
      queueMonitoringIngest(request, {
        type: 'api-request',
        requestId,
        timestamp: startedAt.toISOString(),
        method: request.method.toUpperCase(),
        endpoint: pathname,
        statusCode,
        duration,
        requestSize,
        responseSize,
        userId,
        sessionId: context.sessionId,
        ip: context.ip,
        userAgent: context.userAgent,
        query: context.query as Record<string, unknown> | undefined,
        error: isServerError ? `HTTP ${statusCode}` : undefined,
        errorName: isServerError ? 'HttpError' : undefined,
      });
    }

    // Log response
    logResponse(request, statusCode, startTime, {
      requestId,
      userId,
      requestSize,
      responseSize
    });

    // Log slow requests
    if (duration > 1000) {
      requestLogger.warn(`Slow request detected: ${duration}ms`, {
        threshold: 1000,
        actual: duration
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

    // Track error metrics
    await metricsCollector.track({
      endpoint: pathname,
      method: request.method,
      statusCode: 500,
      duration,
      timestamp: startedAt,
      userId,
      ip: context.ip,
      userAgent: context.userAgent,
      error: errorMessage
    });

    if (pathname.startsWith('/api')) {
      queueMonitoringIngest(request, {
        type: 'api-request',
        requestId,
        timestamp: startedAt.toISOString(),
        method: request.method.toUpperCase(),
        endpoint: pathname,
        statusCode: 500,
        duration,
        requestSize: getRequestSize(request),
        responseSize: 0,
        userId,
        sessionId: context.sessionId,
        ip: context.ip,
        userAgent: context.userAgent,
        error: errorMessage,
        errorName,
        errorStack,
        query: context.query as Record<string, unknown> | undefined,
      });
    }

    // Log error
    requestLogger.error(`Request failed: ${context.method} ${context.endpoint}`, error as Error, {
      duration,
      requestId
    });

    // Re-throw the error
    throw error;
  }
}

/**
 * Export metrics for dashboard
 */
export function getMetricsSummary(): MetricsSummary | { message: string } {
  const metrics = metricsCollector.getMetrics();
  
  if (metrics.length === 0) {
    return { message: 'No metrics collected yet' };
  }

  const now = Date.now();
  const recentMetrics = metrics.filter(m => 
    now - m.timestamp.getTime() < 300000 // Last 5 minutes
  );

  const total = recentMetrics.length;
  
  if (total === 0) {
    return { message: 'No recent metrics in the last 5 minutes' };
  }
  
  const errors = recentMetrics.filter(m => m.statusCode >= 400).length;
  const avgDuration = recentMetrics.reduce((sum, m) => sum + m.duration, 0) / total;

  // Build byEndpoint for topEndpoints
  const byEndpoint = recentMetrics.reduce((acc, m) => {
    const key = `${m.method} ${m.endpoint}`;
    if (!acc[key]) acc[key] = { count: 0, avgDuration: 0, errors: 0 };
    acc[key].count++;
    acc[key].avgDuration += m.duration;
    if (m.statusCode >= 400) acc[key].errors++;
    return acc;
  }, {} as Record<string, EndpointMetrics>);

  // Calculate averages
  Object.keys(byEndpoint).forEach(key => {
    byEndpoint[key].avgDuration /= byEndpoint[key].count;
  });

  return {
    total,
    errors,
    errorRate: (errors / total) * 100,
    avgDuration: Math.round(avgDuration),
    endpoints: Object.keys(byEndpoint).length,
    topEndpoints: Object.entries(byEndpoint)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 5) as Array<[string, EndpointMetrics]>
  };
}

// Export everything
export { metricsCollector };