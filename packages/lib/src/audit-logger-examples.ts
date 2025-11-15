/**
 * Audit Logger - Usage Examples and Integration Guide
 *
 * This file demonstrates how to integrate audit logging throughout PageSpace
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  withAudit,
  withAuditAiTool,
  withAuditRealtimeEvent,
  withAuditBackgroundJob,
  logAudit,
} from './audit-logger-middleware';
import {
  auditPageOperation,
  auditPermissionChange,
  auditAiToolCall,
  auditFileOperation,
  auditDriveOperation,
  auditAuthEvent,
} from './audit-logger';

// ============================================================================
// EXAMPLE 1: API Route with Automatic Audit Logging
// ============================================================================

/**
 * Example: Update page API route with automatic audit logging
 *
 * File: apps/web/src/app/api/pages/[id]/route.ts
 */
export const PUT_EXAMPLE = withAudit(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params;
    const body = await request.json();

    // Your existing handler code
    // const updatedPage = await updatePage(id, body);
    // return Response.json(updatedPage);

    return Response.json({ success: true, id });
  },
  {
    action: 'PAGE_UPDATED',
    resourceType: 'page',
    getResourceId: async (req, ctx) => (await ctx.params).id,
    // Optionally fetch page details for better audit trail
    getResourceName: async (req, ctx) => {
      // const page = await getPage((await ctx.params).id);
      // return page?.name;
      return 'Example Page';
    },
    getDriveId: async (req, ctx) => {
      // const page = await getPage((await ctx.params).id);
      // return page?.driveId;
      return undefined;
    },
    captureChanges: true, // Captures request body as "after" in changes
  }
);

/**
 * Example: Delete page API route
 */
export const DELETE_EXAMPLE = withAudit(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params;

    // Capture "before" state for audit trail
    // const pageBeforeDelete = await getPage(id);

    // Delete the page
    // await deletePage(id);

    return Response.json({ success: true });
  },
  {
    action: 'PAGE_DELETED',
    resourceType: 'page',
    getResourceId: async (req, ctx) => (await ctx.params).id,
    getMetadata: async (req, ctx) => {
      // Capture page state before deletion
      // const page = await getPage((await ctx.params).id);
      return {
        // deletedAt: new Date().toISOString(),
        // pageType: page?.type,
      };
    },
  }
);

// ============================================================================
// EXAMPLE 2: Manual Audit Logging in Existing Code
// ============================================================================

/**
 * Example: Manual audit logging when creating a page
 *
 * Use this when you can't use middleware (e.g., in service functions)
 */
async function createPageExample(userId: string, driveId: string, data: any) {
  // Your existing code
  const newPage = {
    id: 'page_123',
    name: data.name,
    driveId,
    createdAt: new Date(),
  };

  // Manual audit logging (fire and forget - won't block)
  await auditPageOperation('PAGE_CREATED', {
    userId,
    pageId: newPage.id,
    pageName: newPage.name,
    driveId,
    metadata: {
      type: data.type,
      template: data.templateId,
    },
  });

  return newPage;
}

/**
 * Example: Audit permission changes
 */
async function grantPermissionExample(
  grantedBy: string,
  targetUserId: string,
  pageId: string,
  role: string
) {
  // Your existing permission grant code
  // await grantPermission(targetUserId, pageId, role);

  // Audit the permission change
  await auditPermissionChange('PERMISSION_GRANTED', {
    userId: grantedBy,
    targetUserId,
    resourceType: 'page',
    resourceId: pageId,
    changes: {
      after: { role, grantedAt: new Date().toISOString() },
    },
    metadata: {
      targetUserEmail: 'user@example.com', // Will be hashed automatically
    },
  });
}

// ============================================================================
// EXAMPLE 3: AI Tool Execution Tracking
// ============================================================================

/**
 * Example: Track AI tool execution in AI conversation handler
 *
 * File: apps/web/src/app/api/ai/chat/route.ts
 */
async function handleToolCallExample(
  toolName: string,
  toolArgs: any,
  userId: string,
  pageId: string,
  driveId: string
) {
  // Wrap tool execution with audit logging
  const result = await withAuditAiTool(
    async () => {
      // Your existing tool execution code
      // return await executeSearchTool(toolArgs);
      return { results: [] };
    },
    {
      userId,
      toolName,
      pageId,
      driveId,
      metadata: {
        args: toolArgs,
        timestamp: new Date().toISOString(),
      },
    }
  );

  return result;
}

/**
 * Alternative: Manual AI tool audit logging
 */
async function manualAiToolExample(userId: string, pageId: string) {
  try {
    // Execute tool
    const result = { success: true };

    // Log successful execution
    await auditAiToolCall({
      userId,
      toolName: 'search_pages',
      pageId,
      metadata: { query: 'example', resultCount: 5 },
      success: true,
    });

    return result;
  } catch (error) {
    // Log failed execution
    await auditAiToolCall({
      userId,
      toolName: 'search_pages',
      pageId,
      metadata: { query: 'example' },
      success: false,
      errorMessage: (error as Error).message,
    });

    throw error;
  }
}

// ============================================================================
// EXAMPLE 4: Real-time Event Tracking (Socket.IO)
// ============================================================================

/**
 * Example: Audit real-time page updates
 *
 * File: apps/realtime/src/handlers/page-handler.ts
 */
function setupRealtimeAuditExample(io: any) {
  io.on('connection', (socket: any) => {
    // Wrap event handler with audit logging
    socket.on(
      'page:update',
      withAuditRealtimeEvent(
        async (data: { pageId: string; changes: any }) => {
          // Your existing real-time update handler
          // await broadcastPageUpdate(data);
          console.log('Page updated:', data.pageId);
        },
        {
          action: 'PAGE_UPDATED',
          getUserId: (sock) => sock.data.userId,
          getResourceId: (data) => data.pageId,
          getMetadata: (data) => ({
            source: 'realtime',
            changeType: 'collaborative_edit',
          }),
          socket,
        }
      )
    );

    // Audit connection events
    socket.on('disconnect', async () => {
      await logAudit('REALTIME_DISCONNECTED', {
        userId: socket.data.userId,
        sessionId: socket.id,
        metadata: {
          connectedDuration: Date.now() - socket.data.connectedAt,
        },
        service: 'realtime',
      });
    });
  });
}

// ============================================================================
// EXAMPLE 5: File Processing Background Jobs
// ============================================================================

/**
 * Example: Audit file processing jobs
 *
 * File: apps/processor/src/jobs/process-file.ts
 */
async function processFileExample(fileId: string, userId: string) {
  await withAuditBackgroundJob(
    async () => {
      // Your existing file processing logic
      // await optimizeImage(fileId);
      // await extractMetadata(fileId);
      console.log('Processing file:', fileId);
    },
    {
      jobName: 'process_file',
      jobId: fileId,
      userId,
      metadata: {
        fileType: 'image/png',
        fileSize: 1024000,
      },
      service: 'processor',
    }
  );
}

// ============================================================================
// EXAMPLE 6: Authentication Events
// ============================================================================

/**
 * Example: Audit login events
 *
 * File: apps/web/src/app/api/auth/login/route.ts
 */
export async function loginExample(request: NextRequest) {
  const body = await request.json();
  const { email, password } = body;

  try {
    // Your existing login logic
    // const user = await authenticateUser(email, password);
    const user = { id: 'user_123', email };

    // Audit successful login
    await auditAuthEvent('USER_LOGIN', {
      userId: user.id,
      userEmail: user.email,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0] || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      success: true,
      metadata: {
        method: 'email_password',
      },
    });

    return Response.json({ success: true, userId: user.id });
  } catch (error) {
    // Audit failed login
    await auditAuthEvent('USER_LOGIN', {
      userEmail: email, // No userId since login failed
      ip: request.headers.get('x-forwarded-for')?.split(',')[0] || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      success: false,
      errorMessage: 'Invalid credentials',
      metadata: {
        method: 'email_password',
        reason: 'invalid_credentials',
      },
    });

    return Response.json({ error: 'Invalid credentials' }, { status: 401 });
  }
}

// ============================================================================
// EXAMPLE 7: Drive Operations
// ============================================================================

/**
 * Example: Audit drive member addition
 */
async function addDriveMemberExample(
  driveId: string,
  addedBy: string,
  newMemberId: string,
  role: string
) {
  // Your existing add member logic
  // await addMemberToDrive(driveId, newMemberId, role);

  // Audit the operation
  await auditDriveOperation('DRIVE_MEMBER_ADDED', {
    userId: addedBy,
    driveId,
    driveName: 'Example Drive',
    metadata: {
      newMemberId,
      newMemberEmail: 'newmember@example.com',
      role,
    },
  });
}

// ============================================================================
// EXAMPLE 8: File Operations
// ============================================================================

/**
 * Example: Audit file upload
 */
async function uploadFileExample(
  userId: string,
  driveId: string,
  pageId: string,
  file: File
) {
  // Your existing file upload logic
  const uploadedFile = {
    id: 'file_123',
    name: file.name,
    size: file.size,
  };

  // Audit the upload
  await auditFileOperation('FILE_UPLOADED', {
    userId,
    fileId: uploadedFile.id,
    fileName: uploadedFile.name,
    driveId,
    pageId,
    metadata: {
      size: uploadedFile.size,
      mimeType: file.type,
    },
  });

  return uploadedFile;
}

// ============================================================================
// EXAMPLE 9: Batch Operations with Change Tracking
// ============================================================================

/**
 * Example: Audit page move with before/after state
 */
async function movePageExample(
  pageId: string,
  userId: string,
  fromParentId: string,
  toParentId: string
) {
  // Capture before state
  const beforeState = {
    parentId: fromParentId,
    position: 3,
  };

  // Your existing move logic
  // await movePage(pageId, toParentId);

  const afterState = {
    parentId: toParentId,
    position: 1,
  };

  // Audit with change tracking
  await auditPageOperation('PAGE_MOVED', {
    userId,
    pageId,
    pageName: 'Example Page',
    changes: {
      before: beforeState,
      after: afterState,
    },
    metadata: {
      movedAt: new Date().toISOString(),
    },
  });
}

// ============================================================================
// EXAMPLE 10: GDPR Compliance - User Data Deletion
// ============================================================================

/**
 * Example: Handle user deletion request (GDPR right to be forgotten)
 *
 * File: apps/web/src/app/api/users/[id]/gdpr/route.ts
 */
export async function handleUserDeletionExample(userId: string, requestedBy: string) {
  // Import GDPR utilities
  const { anonymizeUserAuditLogs } = await import('./audit-logger-gdpr');

  // Anonymize user's audit trail (preserves compliance while removing PII)
  const anonymizedCount = await anonymizeUserAuditLogs(userId);

  // Log the anonymization (meta audit)
  await logAudit('USER_PASSWORD_CHANGED', {
    // Reusing closest action, or add new 'USER_DATA_ANONYMIZED'
    userId: requestedBy, // Admin who processed the request
    metadata: {
      targetUserId: userId,
      anonymizedAuditLogs: anonymizedCount,
      reason: 'gdpr_right_to_be_forgotten',
      processedAt: new Date().toISOString(),
    },
  });

  return { success: true, anonymizedLogs: anonymizedCount };
}

/**
 * Example: Export user audit logs (GDPR right to data portability)
 */
export async function exportUserDataExample(userId: string) {
  const { exportUserAuditLogs } = await import('./audit-logger-gdpr');

  const auditLogs = await exportUserAuditLogs(userId);

  // Log the export request
  await logAudit('SETTINGS_UPDATED', {
    // Or add 'USER_DATA_EXPORTED'
    userId,
    metadata: {
      exportType: 'audit_logs',
      recordCount: auditLogs.length,
      requestedAt: new Date().toISOString(),
    },
  });

  return auditLogs;
}

// ============================================================================
// PERFORMANCE OPTIMIZATION TIPS
// ============================================================================

/**
 * TIP 1: Batching is enabled by default
 *
 * The audit logger automatically batches writes every 10 seconds or when
 * the buffer reaches 50 entries. This means:
 * - No blocking of user requests
 * - Reduced database load
 * - Guaranteed delivery with retries
 */

/**
 * TIP 2: Force flush for critical events
 *
 * For critical security events, you may want to ensure immediate persistence:
 */
async function criticalSecurityEventExample() {
  const { auditLogger } = await import('./audit-logger');

  await auditLogger.log({
    action: 'USER_PASSWORD_CHANGED',
    userId: 'user_123',
    success: true,
  });

  // Force immediate flush for critical events
  await auditLogger.forceFlush();
}

/**
 * TIP 3: Disable batching for real-time compliance
 *
 * If your compliance requirements mandate immediate persistence,
 * set environment variable:
 *
 * AUDIT_ENABLE_BATCHING=false
 *
 * This will write each audit entry immediately (with retries).
 */

/**
 * TIP 4: Configure retention policies
 *
 * Set default retention period via environment:
 *
 * AUDIT_RETENTION_DAYS=2555  # ~7 years (default)
 *
 * Or per-entry:
 */
async function customRetentionExample() {
  await logAudit('PAGE_CREATED', {
    userId: 'user_123',
    pageId: 'page_123',
    retentionDays: 365, // Keep for 1 year only
  });
}

// ============================================================================
// INTEGRATION CHECKLIST
// ============================================================================

/**
 * To integrate audit logging into your PageSpace application:
 *
 * 1. DATABASE SETUP:
 *    - Run migration to create audit_logs table
 *    - pnpm db:generate
 *    - pnpm db:migrate
 *
 * 2. API ROUTES:
 *    - Wrap mutation routes with withAudit()
 *    - Use appropriate action types (PAGE_CREATED, etc.)
 *    - Capture resource IDs and metadata
 *
 * 3. AI TOOLS:
 *    - Wrap tool executions with withAuditAiTool()
 *    - Or use auditAiToolCall() manually
 *    - Include tool name, args, and results
 *
 * 4. REAL-TIME EVENTS:
 *    - Wrap Socket.IO handlers with withAuditRealtimeEvent()
 *    - Track connections, disconnections, and collaborative edits
 *
 * 5. BACKGROUND JOBS:
 *    - Wrap job functions with withAuditBackgroundJob()
 *    - Track job start, completion, and failures
 *
 * 6. AUTHENTICATION:
 *    - Use auditAuthEvent() for login, logout, signup
 *    - Track failed attempts for security monitoring
 *
 * 7. GDPR COMPLIANCE:
 *    - Implement user deletion handler with anonymizeUserAuditLogs()
 *    - Set up scheduled cleanup with scheduleRetentionCleanup()
 *    - Provide data export with exportUserAuditLogs()
 *
 * 8. MONITORING:
 *    - Monitor audit log buffer size
 *    - Set up alerts for failed writes
 *    - Review retention statistics
 */
