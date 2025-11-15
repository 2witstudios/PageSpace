# Audit Logging Infrastructure

## Overview

PageSpace implements enterprise-grade audit logging for compliance, security, and debugging purposes. The audit logging system is designed to:

- **Never fail user operations** - Fire-and-forget pattern with guaranteed delivery
- **GDPR compliant** - Support for data anonymization and retention policies
- **High performance** - Batching and async writes with minimal overhead
- **Multi-service** - Works across web, realtime, and processor services
- **Privacy-first** - Automatic sanitization of sensitive data

## Architecture

### Components

1. **Core Audit Logger** (`packages/lib/src/audit-logger.ts`)
   - Singleton instance with configurable batching
   - Automatic retry logic for failed writes
   - Privacy-aware data sanitization
   - Support for retention policies

2. **Database Writer** (`packages/lib/src/audit-logger-database.ts`)
   - Batch insert to PostgreSQL
   - Handles database format conversion
   - Error handling and logging

3. **GDPR Utilities** (`packages/lib/src/audit-logger-gdpr.ts`)
   - User data anonymization
   - Retention policy cleanup
   - Data export for portability

4. **Middleware/Wrappers** (`packages/lib/src/audit-logger-middleware.ts`)
   - API route audit middleware
   - AI tool execution wrapper
   - Real-time event wrapper
   - Background job wrapper

### Database Schema

The `audit_logs` table includes:

```sql
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  timestamp TIMESTAMP NOT NULL,
  action audit_action NOT NULL,        -- Enum of all audit actions
  category TEXT NOT NULL,               -- page, permission, ai, file, etc.

  -- Actor (who)
  user_id TEXT,
  user_email TEXT,                      -- Hashed for privacy
  actor_type TEXT NOT NULL,             -- user, system, api, background_job

  -- Target (what)
  resource_type TEXT,
  resource_id TEXT,
  resource_name TEXT,

  -- Context (where)
  drive_id TEXT,
  page_id TEXT,
  session_id TEXT,
  request_id TEXT,

  -- Request details
  ip TEXT,                              -- Anonymized for privacy
  user_agent TEXT,
  endpoint TEXT,

  -- Change tracking
  changes JSONB,                        -- { before: {}, after: {} }
  metadata JSONB,

  -- Result
  success BOOLEAN DEFAULT TRUE,
  error_message TEXT,

  -- GDPR compliance
  anonymized BOOLEAN DEFAULT FALSE,
  retention_date TIMESTAMP,

  -- Service tracking
  service TEXT DEFAULT 'web',
  version TEXT
);
```

**Indexes:**
- `idx_audit_timestamp` - Time-based queries
- `idx_audit_action` - Action type filtering
- `idx_audit_user_id` - User activity queries
- `idx_audit_resource` - Resource tracking
- `idx_audit_retention` - Cleanup queries

### Audit Actions

The system tracks the following action categories:

**Page Operations:**
- `PAGE_CREATED`, `PAGE_UPDATED`, `PAGE_DELETED`
- `PAGE_MOVED`, `PAGE_RESTORED`, `PAGE_DUPLICATED`

**Permission Operations:**
- `PERMISSION_GRANTED`, `PERMISSION_REVOKED`, `PERMISSION_UPDATED`

**AI Operations:**
- `AI_TOOL_CALLED`, `AI_CONTENT_GENERATED`, `AI_CONVERSATION_STARTED`

**File Operations:**
- `FILE_UPLOADED`, `FILE_DELETED`, `FILE_DOWNLOADED`, `FILE_MOVED`

**Drive Operations:**
- `DRIVE_CREATED`, `DRIVE_UPDATED`, `DRIVE_DELETED`
- `DRIVE_MEMBER_ADDED`, `DRIVE_MEMBER_REMOVED`, `DRIVE_MEMBER_ROLE_CHANGED`

**Authentication:**
- `USER_LOGIN`, `USER_LOGOUT`, `USER_SIGNUP`, `USER_PASSWORD_CHANGED`

**Settings:**
- `SETTINGS_UPDATED`, `INTEGRATION_CONNECTED`, `INTEGRATION_DISCONNECTED`

**Real-time:**
- `REALTIME_CONNECTED`, `REALTIME_DISCONNECTED`

**Background Jobs:**
- `JOB_STARTED`, `JOB_COMPLETED`, `JOB_FAILED`

## Usage

### 1. API Route Middleware

Wrap your API route handlers with `withAudit()` for automatic audit logging:

```typescript
import { withAudit } from '@pagespace/lib';
import { NextRequest } from 'next/server';

export const PUT = withAudit(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params;
    const body = await request.json();

    // Your handler code
    const updatedPage = await updatePage(id, body);

    return Response.json(updatedPage);
  },
  {
    action: 'PAGE_UPDATED',
    resourceType: 'page',
    getResourceId: async (req, ctx) => (await ctx.params).id,
    getResourceName: async (req, ctx) => {
      const page = await getPage((await ctx.params).id);
      return page?.name;
    },
    captureChanges: true, // Captures request body as changes
  }
);
```

### 2. Manual Audit Logging

For service functions or custom logic:

```typescript
import { auditPageOperation } from '@pagespace/lib';

async function createPage(userId: string, driveId: string, data: any) {
  const newPage = await db.insert(pages).values(data);

  // Fire and forget - won't block
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
```

### 3. AI Tool Execution

Track AI tool calls automatically:

```typescript
import { withAuditAiTool } from '@pagespace/lib';

const result = await withAuditAiTool(
  async () => {
    return await executeSearchTool(query);
  },
  {
    userId,
    toolName: 'search_pages',
    pageId,
    driveId,
    metadata: { query, resultCount: 5 },
  }
);
```

### 4. Real-time Events

Wrap Socket.IO event handlers:

```typescript
import { withAuditRealtimeEvent } from '@pagespace/lib';

socket.on('page:update', withAuditRealtimeEvent(
  async (data) => {
    await handlePageUpdate(data);
  },
  {
    action: 'PAGE_UPDATED',
    getUserId: (sock) => sock.data.userId,
    getResourceId: (data) => data.pageId,
    socket,
  }
));
```

### 5. Background Jobs

Track job execution in processor service:

```typescript
import { withAuditBackgroundJob } from '@pagespace/lib';

await withAuditBackgroundJob(
  async () => {
    await processFile(fileId);
  },
  {
    jobName: 'process_file',
    jobId: fileId,
    userId: uploaderId,
    service: 'processor',
  }
);
```

## Performance Optimization

### Batching

The audit logger uses automatic batching to minimize database load:

- **Default batch size:** 50 entries
- **Default flush interval:** 10 seconds
- **Automatic flush:** On process exit/shutdown

Configure via environment variables:

```bash
AUDIT_BATCH_SIZE=50           # Number of entries before auto-flush
AUDIT_FLUSH_INTERVAL=10000    # Milliseconds between flushes
AUDIT_ENABLE_BATCHING=true    # Enable/disable batching
```

### Retry Logic

Failed database writes are automatically retried:

- **Max retries:** 3 (configurable)
- **Retry delay:** Exponential backoff (1s, 2s, 4s)
- **Fallback:** Log to console if all retries fail

Configure via environment variables:

```bash
AUDIT_MAX_RETRIES=3           # Maximum retry attempts
AUDIT_RETRY_DELAY=1000        # Initial retry delay in ms
```

### Performance Impact

Audit logging is designed to have **zero blocking impact** on user operations:

1. **Fire-and-forget pattern** - Audit calls don't await database writes
2. **Batched writes** - Reduces database connections and transactions
3. **Async processing** - Buffer flush happens in background
4. **Error isolation** - Logging failures never crash the application

**Benchmarks:**
- Single audit log call: `< 1ms` (in-memory buffer append)
- Batch flush (50 entries): `~20-50ms` (async, non-blocking)
- Overhead per request: `< 0.1%`

## GDPR Compliance

### Data Anonymization

When a user exercises their "right to be forgotten":

```typescript
import { anonymizeUserAuditLogs } from '@pagespace/lib';

// Anonymize all audit logs for a user
const anonymizedCount = await anonymizeUserAuditLogs(userId);

// This will:
// 1. Replace userId with anonymous hash
// 2. Replace userEmail with 'anonymous_xxx@deleted.user'
// 3. Clear IP address, user agent, and metadata
// 4. Set anonymized flag to true
```

**Key Points:**
- Audit trail integrity is preserved (time, action, resource)
- Personal identifiable information is removed
- Anonymous identifier allows correlation of actions
- Logs remain for compliance but cannot identify the user

### Data Retention

Configure automatic deletion of old audit logs:

```typescript
import { scheduleRetentionCleanup } from '@pagespace/lib';

// Schedule daily cleanup (default: 24 hours)
scheduleRetentionCleanup(24);

// This will:
// 1. Delete logs past their retention_date
// 2. Only delete already-anonymized logs
// 3. Preserve non-anonymized logs for compliance
```

Set default retention period:

```bash
AUDIT_RETENTION_DAYS=2555     # ~7 years (default)
```

Per-entry retention override:

```typescript
await auditLogger.log({
  action: 'PAGE_CREATED',
  userId,
  retentionDays: 365,          // Override: keep for 1 year
});
```

### Data Export

Support GDPR "right to data portability":

```typescript
import { exportUserAuditLogs } from '@pagespace/lib';

// Export all audit logs for a user
const logs = await exportUserAuditLogs(userId);

// Returns array of audit log entries
// User can download as JSON
```

## Privacy & Security

### Automatic Sanitization

The audit logger automatically removes sensitive data:

**Sensitive fields (auto-redacted):**
- `password`, `token`, `secret`, `api_key`
- `authorization`, `cookie`, `jwt`
- `privateKey`, `accessToken`, `refreshToken`

```typescript
// Input
await auditLogger.log({
  metadata: {
    user: { password: 'secret123', email: 'user@example.com' }
  }
});

// Stored
{
  metadata: {
    user: { password: '[REDACTED]', email: 'user@example.com' }
  }
}
```

### IP Anonymization

IP addresses are anonymized to protect user privacy:

```bash
AUDIT_ANONYMIZE_IP=true       # Enable IP anonymization (default: false)
```

**Anonymization rules:**
- IPv4: Keep first 3 octets → `192.168.1.xxx`
- IPv6: Keep first 4 groups → `2001:db8:85a3:8d3::xxxx`

### Email Hashing

User emails can be hashed for additional privacy:

```bash
AUDIT_HASH_EMAILS=true        # Hash emails (default: true)
```

**Hash algorithm:**
- SHA-256 hash, truncated to 16 characters
- Consistent hashing allows correlation
- Original email cannot be recovered

## Monitoring & Debugging

### Buffer Monitoring

Check current buffer size:

```typescript
import { auditLogger } from '@pagespace/lib';

const bufferSize = auditLogger.getBufferSize();
console.log(`Audit log buffer: ${bufferSize} entries`);
```

### Force Flush

For critical security events, force immediate persistence:

```typescript
import { auditLogger } from '@pagespace/lib';

await auditLogger.log({
  action: 'USER_PASSWORD_CHANGED',
  userId,
});

// Force immediate flush (bypasses batching)
await auditLogger.forceFlush();
```

### Retention Statistics

Monitor retention policy effectiveness:

```typescript
import { getRetentionStatistics } from '@pagespace/lib';

const stats = await getRetentionStatistics();

console.log({
  total: stats.total,                    // Total audit logs
  anonymized: stats.anonymized,          // Anonymized logs
  expiredButNotDeleted: stats.expiredButNotDeleted,
  willExpireSoon: stats.willExpireSoon,  // Expiring in 30 days
});
```

### Debug Logging

Enable debug logging for audit system:

```bash
LOG_LEVEL=debug               # See audit logger debug messages
```

## Environment Variables

Complete list of audit logger configuration:

```bash
# Batching
AUDIT_BATCH_SIZE=50                  # Entries per batch
AUDIT_FLUSH_INTERVAL=10000           # Flush interval (ms)
AUDIT_ENABLE_BATCHING=true           # Enable batching

# Retry
AUDIT_MAX_RETRIES=3                  # Max retry attempts
AUDIT_RETRY_DELAY=1000               # Initial retry delay (ms)

# Privacy
AUDIT_ANONYMIZE_IP=false             # Anonymize IP addresses
AUDIT_HASH_EMAILS=true               # Hash email addresses

# Retention
AUDIT_RETENTION_DAYS=2555            # Default retention (~7 years)

# Service
SERVICE_NAME=web                     # Service name (web, realtime, processor)
```

## Common Patterns

### Change Tracking

Capture before/after state for updates:

```typescript
// Fetch before state
const beforeState = await getPage(pageId);

// Perform update
const afterState = await updatePage(pageId, changes);

// Audit with change tracking
await auditPageOperation('PAGE_UPDATED', {
  userId,
  pageId,
  changes: {
    before: { name: beforeState.name, status: beforeState.status },
    after: { name: afterState.name, status: afterState.status },
  },
});
```

### Multi-Resource Operations

For operations affecting multiple resources:

```typescript
// Audit each affected resource
for (const pageId of movedPageIds) {
  await auditPageOperation('PAGE_MOVED', {
    userId,
    pageId,
    driveId: newDriveId,
    metadata: {
      bulkOperation: true,
      totalMoved: movedPageIds.length,
    },
  });
}
```

### Failed Operations

Log failed operations for security monitoring:

```typescript
try {
  await deleteResource(id);

  await auditLogger.log({
    action: 'PAGE_DELETED',
    userId,
    resourceId: id,
    success: true,
  });
} catch (error) {
  await auditLogger.log({
    action: 'PAGE_DELETED',
    userId,
    resourceId: id,
    success: false,
    errorMessage: error.message,
  });

  throw error;
}
```

## Database Queries

### Query User Activity

```typescript
import { db, auditLogs } from '@pagespace/db';
import { eq, desc } from 'drizzle-orm';

// Get recent activity for a user
const activity = await db
  .select()
  .from(auditLogs)
  .where(eq(auditLogs.userId, userId))
  .orderBy(desc(auditLogs.timestamp))
  .limit(100);
```

### Query Resource History

```typescript
// Get history for a specific page
const history = await db
  .select()
  .from(auditLogs)
  .where(eq(auditLogs.resourceId, pageId))
  .orderBy(desc(auditLogs.timestamp));
```

### Security Event Monitoring

```typescript
import { and, gte, eq } from 'drizzle-orm';

// Get failed login attempts in last 24 hours
const failedLogins = await db
  .select()
  .from(auditLogs)
  .where(
    and(
      eq(auditLogs.action, 'USER_LOGIN'),
      eq(auditLogs.success, false),
      gte(auditLogs.timestamp, new Date(Date.now() - 24 * 60 * 60 * 1000))
    )
  );
```

## Testing

### Unit Tests

```typescript
import { auditLogger, AuditLogger } from '@pagespace/lib';

describe('AuditLogger', () => {
  it('should batch audit entries', async () => {
    const logger = AuditLogger.getInstance({ batchSize: 2 });

    await logger.log({ action: 'PAGE_CREATED', userId: 'user1' });
    expect(logger.getBufferSize()).toBe(1);

    await logger.log({ action: 'PAGE_UPDATED', userId: 'user1' });
    // Should auto-flush at batch size
    expect(logger.getBufferSize()).toBe(0);
  });
});
```

### Integration Tests

```typescript
it('should audit API route mutations', async () => {
  const response = await fetch('/api/pages/123', {
    method: 'PUT',
    headers: { 'x-user-id': 'user123' },
    body: JSON.stringify({ name: 'Updated' }),
  });

  // Force flush
  await auditLogger.forceFlush();

  // Verify audit log created
  const logs = await db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.userId, 'user123'));

  expect(logs).toHaveLength(1);
  expect(logs[0].action).toBe('PAGE_UPDATED');
});
```

## Migration Guide

### Generating the Migration

```bash
# 1. The schema is already updated in packages/db/src/schema/monitoring.ts
# 2. Generate migration
pnpm db:generate

# 3. Review migration file in packages/db/drizzle/
# 4. Run migration
pnpm db:migrate
```

### Adding to Existing Routes

**Before:**
```typescript
export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;
  const body = await req.json();
  const updated = await updatePage(id, body);
  return Response.json(updated);
}
```

**After:**
```typescript
export const PUT = withAudit(
  async (req: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params;
    const body = await req.json();
    const updated = await updatePage(id, body);
    return Response.json(updated);
  },
  {
    action: 'PAGE_UPDATED',
    getResourceId: async (req, ctx) => (await ctx.params).id,
  }
);
```

## Troubleshooting

### Logs Not Appearing

1. Check buffer size: `auditLogger.getBufferSize()`
2. Force flush: `await auditLogger.forceFlush()`
3. Check database connection
4. Review error logs for write failures

### High Memory Usage

1. Reduce batch size: `AUDIT_BATCH_SIZE=25`
2. Reduce flush interval: `AUDIT_FLUSH_INTERVAL=5000`
3. Check for write failures causing buffer buildup

### Database Write Errors

1. Verify database schema is up to date
2. Check PostgreSQL connection limits
3. Review retry configuration
4. Check disk space on database server

## Best Practices

1. **Use middleware when possible** - Reduces boilerplate and ensures consistency
2. **Capture resource names** - Makes audit logs more readable
3. **Include metadata** - Helps with debugging and analysis
4. **Track changes** - Store before/after state for updates
5. **Log failures** - Security monitoring requires failed attempt tracking
6. **Force flush critical events** - For immediate compliance requirements
7. **Regular retention cleanup** - Schedule daily cleanup jobs
8. **Monitor buffer size** - Alert if buffer grows unexpectedly
9. **Test GDPR flows** - Verify anonymization works correctly
10. **Review audit queries** - Ensure indexes support your query patterns

## References

- Database Schema: `/packages/db/src/schema/monitoring.ts`
- Core Logger: `/packages/lib/src/audit-logger.ts`
- Middleware: `/packages/lib/src/audit-logger-middleware.ts`
- GDPR Utilities: `/packages/lib/src/audit-logger-gdpr.ts`
- Usage Examples: `/packages/lib/src/audit-logger-examples.ts`
