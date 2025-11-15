# Audit Trail Migration Guide

This guide walks through deploying the audit trail and versioning system to a PageSpace instance.

## Pre-Migration Checklist

- [ ] Backup production database
- [ ] Test migration on staging environment
- [ ] Review generated SQL migration
- [ ] Plan for downtime (if needed)
- [ ] Communicate changes to users
- [ ] Prepare monitoring and alerts

## Step 1: Generate Migration

From the PageSpace root directory:

```bash
pnpm db:generate
```

This will generate a new migration file in `packages/db/drizzle/`.

## Step 2: Review Generated Migration

Open the generated migration file and verify:

### Expected Changes

**New Tables:**
- `audit_events` - Master audit log
- `page_versions` - Page content snapshots
- `ai_operations` - AI operation tracking

**New Enums:**
- `audit_action_type` - Action types (PAGE_UPDATE, etc.)
- `audit_entity_type` - Entity types (PAGE, DRIVE, etc.)
- `ai_agent_type` - AI agent types (ASSISTANT, EDITOR, etc.)

**New Indexes:**
- Multiple indexes on `audit_events` for query performance
- Indexes on `page_versions` for version lookups
- Indexes on `ai_operations` for usage analysis

### Sample Migration SQL

```sql
-- Create enums
CREATE TYPE "audit_action_type" AS ENUM (
  'PAGE_CREATE', 'PAGE_UPDATE', 'PAGE_DELETE', 'PAGE_RESTORE',
  'PAGE_MOVE', 'PAGE_RENAME', 'PAGE_DUPLICATE',
  'PERMISSION_GRANT', 'PERMISSION_REVOKE', 'PERMISSION_UPDATE',
  'DRIVE_CREATE', 'DRIVE_UPDATE', 'DRIVE_DELETE', 'DRIVE_RESTORE',
  'MEMBER_ADD', 'MEMBER_REMOVE', 'MEMBER_UPDATE_ROLE',
  'FILE_UPLOAD', 'FILE_DELETE', 'FILE_UPDATE',
  'MESSAGE_CREATE', 'MESSAGE_UPDATE', 'MESSAGE_DELETE',
  'AI_EDIT', 'AI_GENERATE', 'AI_TOOL_CALL', 'AI_CONVERSATION',
  'SETTINGS_UPDATE', 'EXPORT', 'IMPORT'
);

CREATE TYPE "audit_entity_type" AS ENUM (
  'PAGE', 'DRIVE', 'PERMISSION', 'MEMBER', 'FILE',
  'MESSAGE', 'SETTINGS', 'AI_OPERATION'
);

CREATE TYPE "ai_agent_type" AS ENUM (
  'ASSISTANT', 'EDITOR', 'RESEARCHER', 'CODER',
  'ANALYST', 'WRITER', 'REVIEWER', 'CUSTOM'
);

-- Create audit_events table
CREATE TABLE "audit_events" (
  "id" text PRIMARY KEY NOT NULL,
  "action_type" audit_action_type NOT NULL,
  "entity_type" audit_entity_type NOT NULL,
  "entity_id" text NOT NULL,
  "user_id" text,
  "is_ai_action" boolean DEFAULT false NOT NULL,
  "ai_operation_id" text,
  "drive_id" text,
  "before_state" jsonb,
  "after_state" jsonb,
  "changes" jsonb,
  "description" text,
  "reason" text,
  "metadata" jsonb,
  "request_id" text,
  "session_id" text,
  "ip_address" text,
  "user_agent" text,
  "operation_id" text,
  "parent_event_id" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE set null,
  FOREIGN KEY ("drive_id") REFERENCES "drives"("id") ON DELETE cascade
);

-- Create page_versions table
CREATE TABLE "page_versions" (
  "id" text PRIMARY KEY NOT NULL,
  "page_id" text NOT NULL,
  "version_number" integer NOT NULL,
  "content" jsonb NOT NULL,
  "title" text NOT NULL,
  "page_type" text NOT NULL,
  "metadata" jsonb,
  "audit_event_id" text,
  "created_by" text,
  "is_ai_generated" boolean DEFAULT false NOT NULL,
  "content_size" integer,
  "change_summary" text,
  "change_type" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  FOREIGN KEY ("page_id") REFERENCES "pages"("id") ON DELETE cascade,
  FOREIGN KEY ("audit_event_id") REFERENCES "audit_events"("id") ON DELETE set null,
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE set null
);

-- Create ai_operations table
CREATE TABLE "ai_operations" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "agent_type" ai_agent_type NOT NULL,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "operation_type" text NOT NULL,
  "prompt" text,
  "system_prompt" text,
  "conversation_id" text,
  "message_id" text,
  "drive_id" text,
  "page_id" text,
  "tools_called" jsonb,
  "tool_results" jsonb,
  "completion" text,
  "actions_performed" jsonb,
  "duration" integer,
  "input_tokens" integer,
  "output_tokens" integer,
  "total_cost" integer,
  "status" text DEFAULT 'completed' NOT NULL,
  "error" text,
  "metadata" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "completed_at" timestamp,
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade,
  FOREIGN KEY ("drive_id") REFERENCES "drives"("id") ON DELETE cascade,
  FOREIGN KEY ("page_id") REFERENCES "pages"("id") ON DELETE set null
);

-- Create indexes
CREATE INDEX "audit_events_drive_created_idx" ON "audit_events" ("drive_id", "created_at");
CREATE INDEX "audit_events_user_created_idx" ON "audit_events" ("user_id", "created_at");
CREATE INDEX "audit_events_entity_idx" ON "audit_events" ("entity_type", "entity_id", "created_at");
CREATE INDEX "audit_events_action_type_idx" ON "audit_events" ("action_type");
CREATE INDEX "audit_events_is_ai_action_idx" ON "audit_events" ("is_ai_action", "created_at");
CREATE INDEX "audit_events_ai_operation_idx" ON "audit_events" ("ai_operation_id");
CREATE INDEX "audit_events_operation_id_idx" ON "audit_events" ("operation_id");
CREATE INDEX "audit_events_request_id_idx" ON "audit_events" ("request_id");
CREATE INDEX "audit_events_created_at_idx" ON "audit_events" ("created_at");

CREATE INDEX "page_versions_page_version_idx" ON "page_versions" ("page_id", "version_number");
CREATE INDEX "page_versions_page_created_idx" ON "page_versions" ("page_id", "created_at");
CREATE INDEX "page_versions_created_by_idx" ON "page_versions" ("created_by", "created_at");
CREATE INDEX "page_versions_is_ai_generated_idx" ON "page_versions" ("is_ai_generated");
CREATE INDEX "page_versions_audit_event_idx" ON "page_versions" ("audit_event_id");
CREATE INDEX "page_versions_created_at_idx" ON "page_versions" ("created_at");

CREATE INDEX "ai_operations_user_created_idx" ON "ai_operations" ("user_id", "created_at");
CREATE INDEX "ai_operations_drive_created_idx" ON "ai_operations" ("drive_id", "created_at");
CREATE INDEX "ai_operations_conversation_idx" ON "ai_operations" ("conversation_id");
CREATE INDEX "ai_operations_message_idx" ON "ai_operations" ("message_id");
CREATE INDEX "ai_operations_page_idx" ON "ai_operations" ("page_id", "created_at");
CREATE INDEX "ai_operations_agent_type_idx" ON "ai_operations" ("agent_type", "created_at");
CREATE INDEX "ai_operations_provider_model_idx" ON "ai_operations" ("provider", "model");
CREATE INDEX "ai_operations_status_idx" ON "ai_operations" ("status");
CREATE INDEX "ai_operations_created_at_idx" ON "ai_operations" ("created_at");
```

## Step 3: Run Migration

### Development/Staging

```bash
pnpm db:migrate
```

### Production

**Option A: Zero-downtime (Recommended)**

The migration adds new tables and doesn't modify existing ones, so it can be run without downtime:

```bash
# Connect to production database
pnpm db:migrate
```

**Option B: Maintenance Window**

If you prefer a maintenance window:

1. Enable maintenance mode
2. Run migration
3. Verify tables created
4. Deploy application code
5. Disable maintenance mode

## Step 4: Verify Migration

Run these checks to ensure migration succeeded:

### Check Tables Exist

```sql
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('audit_events', 'page_versions', 'ai_operations');
```

Should return 3 rows.

### Check Indexes Exist

```sql
SELECT indexname
FROM pg_indexes
WHERE tablename IN ('audit_events', 'page_versions', 'ai_operations')
ORDER BY tablename, indexname;
```

Should return all expected indexes (27 total).

### Check Foreign Keys

```sql
SELECT
  tc.table_name,
  kcu.column_name,
  ccu.table_name AS foreign_table_name,
  ccu.column_name AS foreign_column_name
FROM information_schema.table_constraints AS tc
JOIN information_schema.key_column_usage AS kcu
  ON tc.constraint_name = kcu.constraint_name
JOIN information_schema.constraint_column_usage AS ccu
  ON ccu.constraint_name = tc.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_name IN ('audit_events', 'page_versions', 'ai_operations')
ORDER BY tc.table_name;
```

Should show all foreign key relationships.

## Step 5: Optional - Backfill Existing Data

If you want to create audit events for existing pages:

```typescript
// scripts/backfill-audit-trail.ts
import { db, pages, drives, eq, asc } from '@pagespace/db';
import { createAuditEvent, createPageVersion } from '@pagespace/lib/audit';

async function backfillAuditTrail() {
  console.log('Starting audit trail backfill...');

  // Get all existing pages
  const allPages = await db.query.pages.findMany({
    orderBy: [asc(pages.createdAt)],
  });

  console.log(`Found ${allPages.length} pages to backfill`);

  for (const page of allPages) {
    try {
      // Create initial audit event
      const auditEvent = await createAuditEvent({
        actionType: 'PAGE_CREATE',
        entityType: 'PAGE',
        entityId: page.id,
        userId: null, // Unknown user for historical data
        driveId: page.driveId,
        afterState: {
          title: page.title,
          type: page.type,
          content: page.content,
        },
        description: `Historical page creation (backfilled)`,
        reason: 'Backfill script',
        metadata: { backfilled: true },
      });

      // Create initial version
      await createPageVersion({
        pageId: page.id,
        auditEventId: auditEvent.id,
        changeSummary: 'Initial version (backfilled)',
        changeType: 'major',
      });

      console.log(`Backfilled: ${page.title}`);
    } catch (error) {
      console.error(`Failed to backfill page ${page.id}:`, error);
    }
  }

  console.log('Backfill complete!');
}

backfillAuditTrail();
```

Run with:

```bash
pnpm tsx scripts/backfill-audit-trail.ts
```

**Warning**: This can be slow for large datasets. Consider batching:

```typescript
// Process in batches of 100
for (let i = 0; i < allPages.length; i += 100) {
  const batch = allPages.slice(i, i + 100);
  await Promise.all(batch.map(backfillPage));
  console.log(`Processed ${i + batch.length}/${allPages.length}`);
}
```

## Step 6: Deploy Application Code

Deploy the application code that uses the audit trail:

```bash
pnpm build
# Deploy to production
```

## Step 7: Monitor and Verify

### Check Audit Events Being Created

```sql
SELECT
  COUNT(*) as total_events,
  action_type,
  is_ai_action
FROM audit_events
WHERE created_at > NOW() - INTERVAL '1 hour'
GROUP BY action_type, is_ai_action
ORDER BY total_events DESC;
```

### Check Page Versions

```sql
SELECT
  p.title,
  COUNT(pv.id) as version_count,
  MAX(pv.version_number) as latest_version
FROM pages p
LEFT JOIN page_versions pv ON p.id = pv.page_id
GROUP BY p.id, p.title
HAVING COUNT(pv.id) > 0
ORDER BY version_count DESC
LIMIT 10;
```

### Check Index Usage

```sql
SELECT
  schemaname,
  tablename,
  indexname,
  idx_scan as index_scans,
  idx_tup_read as tuples_read,
  idx_tup_fetch as tuples_fetched
FROM pg_stat_user_indexes
WHERE tablename IN ('audit_events', 'page_versions', 'ai_operations')
ORDER BY idx_scan DESC;
```

## Step 8: Set Up Monitoring

### Database Size Monitoring

```sql
SELECT
  table_name,
  pg_size_pretty(pg_total_relation_size(quote_ident(table_name))) as size
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('audit_events', 'page_versions', 'ai_operations')
ORDER BY pg_total_relation_size(quote_ident(table_name)) DESC;
```

### Query Performance Monitoring

Add to monitoring dashboard:
- Audit event creation rate
- Page version creation rate
- AI operation duration
- Index hit rates

## Rollback Plan

If issues arise, you can rollback:

### Rollback Migration

```bash
# Drizzle doesn't have built-in rollback, so manual SQL needed
```

### Manual Rollback SQL

```sql
-- Drop tables
DROP TABLE IF EXISTS ai_operations CASCADE;
DROP TABLE IF EXISTS page_versions CASCADE;
DROP TABLE IF EXISTS audit_events CASCADE;

-- Drop enums
DROP TYPE IF EXISTS ai_agent_type;
DROP TYPE IF EXISTS audit_entity_type;
DROP TYPE IF EXISTS audit_action_type;
```

**Warning**: This will delete all audit data!

## Post-Migration Tasks

### 1. Update Documentation

- Update API documentation
- Update user guides
- Document new features

### 2. Train Team

- Explain new audit capabilities
- Show how to query audit trail
- Demonstrate version restore

### 3. Set Up Retention Policy

Plan for long-term data retention:

```sql
-- Example: Archive events older than 12 months
CREATE TABLE audit_events_archive AS
SELECT * FROM audit_events
WHERE created_at < NOW() - INTERVAL '12 months';

DELETE FROM audit_events
WHERE created_at < NOW() - INTERVAL '12 months';
```

### 4. Configure Alerts

Set up alerts for:
- High audit event creation rate
- Failed AI operations
- Unusually large page versions
- Database size growth

## Troubleshooting

### Migration Fails

**Error: Enum already exists**

```bash
# Clean up and retry
DROP TYPE IF EXISTS audit_action_type CASCADE;
pnpm db:generate
pnpm db:migrate
```

**Error: Table already exists**

```bash
# Check what exists
\dt audit_*
\dt page_versions
\dt ai_operations

# Drop if needed
DROP TABLE IF EXISTS audit_events CASCADE;
DROP TABLE IF EXISTS page_versions CASCADE;
DROP TABLE IF EXISTS ai_operations CASCADE;
```

### Slow Queries

If audit queries are slow:

1. Check index usage:
   ```sql
   EXPLAIN ANALYZE
   SELECT * FROM audit_events
   WHERE drive_id = 'xxx' AND created_at > NOW() - INTERVAL '7 days'
   ORDER BY created_at DESC
   LIMIT 50;
   ```

2. Ensure indexes are being used
3. Consider adding more specific indexes
4. Vacuum and analyze tables:
   ```sql
   VACUUM ANALYZE audit_events;
   VACUUM ANALYZE page_versions;
   VACUUM ANALYZE ai_operations;
   ```

### Large Database Size

If audit tables grow too large:

1. Implement retention policy
2. Archive old data
3. Consider table partitioning:
   ```sql
   -- Partition by month
   CREATE TABLE audit_events_2025_01 PARTITION OF audit_events
   FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');
   ```

## Summary

This migration adds three new tables (`audit_events`, `page_versions`, `ai_operations`) with comprehensive indexing for performance. The migration is backward-compatible and can be run without downtime.

Key Points:
- ✅ No existing tables modified
- ✅ Zero downtime deployment possible
- ✅ Backfilling is optional
- ✅ Rollback plan available
- ✅ Comprehensive monitoring recommended

After migration, all new actions will be automatically tracked in the audit trail.
