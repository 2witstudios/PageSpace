/**
 * Middleware and Wrappers for Automatic Audit Logging
 *
 * Provides convenient wrappers for automatic audit logging in:
 * - API routes
 * - AI tool executions
 * - Real-time events
 * - Background jobs
 */

import { NextRequest, NextResponse } from 'next/server';
import { createId } from '@paralleldrive/cuid2';
import { auditLogger, AuditAction, AuditLogOptions } from './audit-logger';

/**
 * Extract user ID from request headers (set by auth middleware)
 */
function extractUserId(request: NextRequest): string | undefined {
  return request.headers.get('x-user-id') || undefined;
}

/**
 * Extract session ID from request
 */
function extractSessionId(request: NextRequest): string | undefined {
  return request.headers.get('x-session-id') || undefined;
}

/**
 * Extract IP address from request
 */
function extractIp(request: NextRequest): string | undefined {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0] ||
    request.headers.get('x-real-ip') ||
    undefined
  );
}

/**
 * Extract user agent from request
 */
function extractUserAgent(request: NextRequest): string | undefined {
  return request.headers.get('user-agent') || undefined;
}

/**
 * Audit API Route Middleware
 *
 * Automatically logs API mutations (POST, PUT, DELETE, PATCH)
 *
 * Usage:
 * ```typescript
 * export const POST = withAudit(
 *   async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
 *     const { id } = await context.params;
 *     // ... your handler code
 *     return Response.json({ success: true });
 *   },
 *   {
 *     action: 'PAGE_UPDATED',
 *     getResourceId: async (req, ctx) => (await ctx.params).id,
 *     getResourceName: async (req, ctx) => {
 *       // Optionally fetch resource name
 *       const page = await getPage((await ctx.params).id);
 *       return page?.name;
 *     },
 *   }
 * );
 * ```
 */
export function withAudit<T extends { params: Promise<any> }>(
  handler: (request: NextRequest, context: T) => Promise<Response>,
  config: {
    action: AuditAction;
    resourceType?: string;
    getResourceId?: (request: NextRequest, context: T) => Promise<string> | string;
    getResourceName?: (request: NextRequest, context: T) => Promise<string | undefined> | string | undefined;
    getDriveId?: (request: NextRequest, context: T) => Promise<string | undefined> | string | undefined;
    getPageId?: (request: NextRequest, context: T) => Promise<string | undefined> | string | undefined;
    getMetadata?: (request: NextRequest, context: T) => Promise<Record<string, any>> | Record<string, any>;
    captureChanges?: boolean; // If true, captures request body as "after" in changes
  }
) {
  return async (request: NextRequest, context: T): Promise<Response> => {
    const requestId = createId();
    const userId = extractUserId(request);
    const sessionId = extractSessionId(request);
    const ip = extractIp(request);
    const userAgent = extractUserAgent(request);
    const endpoint = request.nextUrl.pathname;

    let response: Response;
    let success = true;
    let errorMessage: string | undefined;

    try {
      // Execute the handler
      response = await handler(request, context);

      // Check if response indicates an error
      if (response.status >= 400) {
        success = false;
        try {
          const body = await response.clone().json();
          errorMessage = body.error || body.message || `HTTP ${response.status}`;
        } catch {
          errorMessage = `HTTP ${response.status}`;
        }
      }
    } catch (error) {
      success = false;
      errorMessage = (error as Error).message;
      throw error; // Re-throw after logging
    } finally {
      // Log audit event (async, won't block response)
      const logOptions: AuditLogOptions = {
        action: config.action,
        userId,
        sessionId,
        requestId,
        ip,
        userAgent,
        endpoint,
        success,
        errorMessage,
      };

      // Extract resource details
      if (config.resourceType) {
        logOptions.resourceType = config.resourceType;
      }

      if (config.getResourceId) {
        const resourceId = await Promise.resolve(config.getResourceId(request, context));
        logOptions.resourceId = resourceId;
      }

      if (config.getResourceName) {
        const resourceName = await Promise.resolve(config.getResourceName(request, context));
        logOptions.resourceName = resourceName;
      }

      if (config.getDriveId) {
        const driveId = await Promise.resolve(config.getDriveId(request, context));
        logOptions.driveId = driveId;
      }

      if (config.getPageId) {
        const pageId = await Promise.resolve(config.getPageId(request, context));
        logOptions.pageId = pageId;
      }

      if (config.getMetadata) {
        const metadata = await Promise.resolve(config.getMetadata(request, context));
        logOptions.metadata = metadata;
      }

      // Capture request body as changes if requested
      if (config.captureChanges) {
        try {
          const body = await request.clone().json();
          logOptions.changes = { after: body };
        } catch {
          // Ignore if body is not JSON
        }
      }

      // Fire and forget - don't await
      auditLogger.log(logOptions).catch(err => {
        console.error('[AuditLogger] Failed to log audit entry:', err);
      });
    }

    return response!;
  };
}

/**
 * Audit wrapper for AI tool executions
 *
 * Usage:
 * ```typescript
 * const result = await withAuditAiTool(
 *   async () => {
 *     return await executeSearchTool(query);
 *   },
 *   {
 *     userId,
 *     toolName: 'search_pages',
 *     pageId,
 *     driveId,
 *     metadata: { query },
 *   }
 * );
 * ```
 */
export async function withAuditAiTool<T>(
  fn: () => Promise<T>,
  options: {
    userId?: string;
    toolName: string;
    pageId?: string;
    driveId?: string;
    metadata?: Record<string, any>;
    requestId?: string;
  }
): Promise<T> {
  let success = true;
  let errorMessage: string | undefined;

  try {
    const result = await fn();
    return result;
  } catch (error) {
    success = false;
    errorMessage = (error as Error).message;
    throw error;
  } finally {
    // Fire and forget audit log
    auditLogger.log({
      action: 'AI_TOOL_CALLED',
      category: 'ai',
      userId: options.userId,
      resourceType: 'ai_tool',
      resourceName: options.toolName,
      pageId: options.pageId,
      driveId: options.driveId,
      metadata: options.metadata,
      success,
      errorMessage,
      requestId: options.requestId,
    }).catch(err => {
      console.error('[AuditLogger] Failed to log AI tool execution:', err);
    });
  }
}

/**
 * Audit wrapper for Socket.IO real-time events
 *
 * Usage:
 * ```typescript
 * socket.on('page:update', withAuditRealtimeEvent(
 *   async (data) => {
 *     await handlePageUpdate(data);
 *   },
 *   {
 *     action: 'PAGE_UPDATED',
 *     getUserId: (socket) => socket.data.userId,
 *     getResourceId: (data) => data.pageId,
 *   }
 * ));
 * ```
 */
export function withAuditRealtimeEvent<T extends any[]>(
  handler: (...args: T) => Promise<void> | void,
  config: {
    action: AuditAction;
    getUserId: (socket?: any) => string | undefined;
    getResourceId?: (...args: T) => string | undefined;
    getMetadata?: (...args: T) => Record<string, any> | undefined;
    socket?: any; // Socket.IO socket instance
  }
) {
  return async (...args: T): Promise<void> => {
    let success = true;
    let errorMessage: string | undefined;

    try {
      await handler(...args);
    } catch (error) {
      success = false;
      errorMessage = (error as Error).message;
      throw error;
    } finally {
      const userId = config.getUserId(config.socket);
      const resourceId = config.getResourceId ? config.getResourceId(...args) : undefined;
      const metadata = config.getMetadata ? config.getMetadata(...args) : undefined;

      // Fire and forget
      auditLogger.log({
        action: config.action,
        userId,
        resourceId,
        metadata,
        success,
        errorMessage,
        service: 'realtime',
      }).catch(err => {
        console.error('[AuditLogger] Failed to log realtime event:', err);
      });
    }
  };
}

/**
 * Audit wrapper for background jobs
 *
 * Usage:
 * ```typescript
 * await withAuditBackgroundJob(
 *   async () => {
 *     await processFile(fileId);
 *   },
 *   {
 *     jobName: 'process_file',
 *     jobId: fileId,
 *     userId: uploaderId,
 *   }
 * );
 * ```
 */
export async function withAuditBackgroundJob<T>(
  fn: () => Promise<T>,
  options: {
    jobName: string;
    jobId?: string;
    userId?: string;
    metadata?: Record<string, any>;
    service?: string;
  }
): Promise<T> {
  // Log job start
  await auditLogger.log({
    action: 'JOB_STARTED',
    category: 'background_job',
    actorType: 'background_job',
    userId: options.userId,
    resourceType: 'job',
    resourceId: options.jobId,
    resourceName: options.jobName,
    metadata: options.metadata,
    service: options.service || 'processor',
  });

  let success = true;
  let errorMessage: string | undefined;

  try {
    const result = await fn();
    return result;
  } catch (error) {
    success = false;
    errorMessage = (error as Error).message;
    throw error;
  } finally {
    // Log job completion/failure
    await auditLogger.log({
      action: success ? 'JOB_COMPLETED' : 'JOB_FAILED',
      category: 'background_job',
      actorType: 'background_job',
      userId: options.userId,
      resourceType: 'job',
      resourceId: options.jobId,
      resourceName: options.jobName,
      metadata: options.metadata,
      success,
      errorMessage,
      service: options.service || 'processor',
    });
  }
}

/**
 * Simple audit log helper for manual logging
 *
 * Usage:
 * ```typescript
 * await logAudit('PAGE_CREATED', {
 *   userId,
 *   pageId: newPage.id,
 *   pageName: newPage.name,
 *   driveId,
 *   metadata: { source: 'template' },
 * });
 * ```
 */
export async function logAudit(
  action: AuditAction,
  options: Omit<AuditLogOptions, 'action'>
): Promise<void> {
  await auditLogger.log({ action, ...options });
}
