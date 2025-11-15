# Audit Performance Optimization - Quick Start Guide

This is a condensed guide for implementing the audit trail performance optimizations. For comprehensive analysis and details, see:
- **Full Analysis**: `docs/3.0-guides-and-tools/audit-performance-analysis.md`
- **Implementation Summary**: `AUDIT_PERFORMANCE_OPTIMIZATION_SUMMARY.md`

## TL;DR

**Problem**: Audit queries slow with millions of events, unbounded storage growth
**Solution**: Composite indexes + Redis caching + async queue + retention policy
**Impact**: 5-50x faster queries, 60-80% storage savings, <1ms audit overhead

## Quick Implementation (Phase 1 - Week 1)

### Step 1: Apply Database Indexes (30 minutes)

```bash
# Review the migration first
cat packages/db/drizzle/migrations/audit_performance_optimizations.sql

# Apply to database (non-blocking, no downtime required)
psql $DATABASE_URL -f packages/db/drizzle/migrations/audit_performance_optimizations.sql

# Verify indexes created
psql $DATABASE_URL -c "
  SELECT indexname, pg_size_pretty(pg_relation_size(indexrelid)) AS size
  FROM pg_stat_user_indexes
  WHERE tablename IN ('audit_events', 'page_versions', 'ai_operations')
  ORDER BY tablename, indexname;
"
```

**Expected Result**: 21 new indexes added, 2-10x faster queries

### Step 2: Enable Redis Caching (2 hours)

**Install Dependencies:**
```bash
pnpm add ioredis
pnpm add -D @types/ioredis
```

**Start Redis:**
```bash
# Using Docker
docker run -d -p 6379:6379 redis:7-alpine

# Or install locally
brew install redis  # macOS
redis-server
```

**Initialize Cache in App:**
```typescript
// In apps/web/src/app/layout.tsx or middleware
import { setRedisClient } from '@pagespace/lib/audit/cache';
import { Redis } from 'ioredis';

// Initialize Redis (do this once on app startup)
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
setRedisClient(redis);
```

**Add Environment Variable:**
```env
# .env.local
REDIS_URL=redis://localhost:6379
AUDIT_CACHE_ENABLED=true
```

**Update Query Functions to Use Cache:**

Example for drive activity feed:

```typescript
// In packages/lib/src/audit/query-audit-events.ts
import {
  getCachedDriveActivity,
  setCachedDriveActivity,
  invalidateDriveActivityCache,
} from './cache';

export async function getDriveActivityFeed(
  driveId: string,
  options: {
    limit?: number;
    offset?: number;
    actionType?: string;
    // ... other filters
  } = {}
) {
  const { limit = 50, offset = 0, ...filters } = options;

  // Try cache first
  const filterHash = JSON.stringify(filters);
  const cached = await getCachedDriveActivity({
    driveId,
    limit,
    offset,
    filters: filterHash,
  });

  if (cached) {
    return cached;
  }

  // Query database
  const events = await getAuditEvents({ driveId, ...filters }, limit);

  // Cache result
  await setCachedDriveActivity(
    { driveId, limit, offset, filters: filterHash },
    events
  );

  return events;
}
```

**Add Cache Invalidation to Write Operations:**

```typescript
// In packages/lib/src/audit/page-audit-helpers.ts
import { invalidateDriveActivityCache, invalidatePageVersionsCache } from './cache';

export async function auditPageUpdate(...) {
  const auditEvent = await createAuditEvent({ ... });

  // Invalidate relevant caches
  if (page.driveId) {
    await invalidateDriveActivityCache(page.driveId);
  }
  await invalidatePageVersionsCache(pageId);

  return auditEvent;
}
```

**Expected Result**: 10x faster repeated queries, 70-80% reduced database load

### Step 3: Test Performance (30 minutes)

**Test Drive Activity Feed:**
```bash
# Without cache (first request)
time curl "http://localhost:3000/api/drives/DRIVE_ID/activity"
# Expected: 50-100ms

# With cache (subsequent requests)
time curl "http://localhost:3000/api/drives/DRIVE_ID/activity"
# Expected: 5-10ms
```

**Check Cache Stats:**
```typescript
import { getAuditCacheStats } from '@pagespace/lib/audit/cache';

const stats = await getAuditCacheStats();
console.log('Total cache keys:', stats.totalKeys);
console.log('Keys by type:', stats.keysByPrefix);
console.log('Memory used:', (stats.memoryUsed / 1024 / 1024).toFixed(2), 'MB');
```

**Verify Index Usage:**
```sql
-- Check if new indexes are being used
EXPLAIN ANALYZE
SELECT * FROM audit_events
WHERE drive_id = 'xxx' AND action_type = 'PAGE_UPDATE'
ORDER BY created_at DESC
LIMIT 50;

-- Look for: "Index Scan using audit_events_drive_action_created_idx"
```

## Phase 2: Async Audit Queue (Optional - Week 2-3)

### Install Dependencies

```bash
pnpm add bullmq
```

### Initialize Queue

```typescript
// In your app startup (apps/web/src/app/api/[...])
import { initAuditQueue, initAuditWorker } from '@pagespace/lib/audit/async-queue';
import { Redis } from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);

// Initialize queue (for adding jobs)
await initAuditQueue(redis);

// Initialize worker (for processing jobs - can be same or separate process)
await initAuditWorker(redis);
```

### Update Audit Functions to Use Async

```typescript
// Before (synchronous)
import { createAuditEvent } from '@pagespace/lib/audit';

await createAuditEvent({ ... });  // Blocks request

// After (asynchronous)
import { createAuditEventAsync } from '@pagespace/lib/audit/async-queue';

await createAuditEventAsync({ ... });  // Returns immediately, <1ms overhead
```

### Monitor Queue

```typescript
import { getAuditQueueStats } from '@pagespace/lib/audit/async-queue';

const stats = await getAuditQueueStats();
console.log('Queue stats:', stats);
// { waiting: 0, active: 2, completed: 1543, failed: 0, delayed: 0 }
```

**Expected Result**: <1ms audit overhead (vs 5-10ms sync), 50x faster bulk operations

## Phase 3: Retention & Archival (Optional - Month 2-3)

### Schedule Retention Job

```bash
# Add to crontab (run daily at 2 AM)
0 2 * * * cd /path/to/PageSpace && pnpm tsx scripts/audit-retention-job.ts

# Or run manually
pnpm tsx scripts/audit-retention-job.ts
```

**Expected Result**: 50-70% reduction in main table size, controlled storage growth

## Monitoring Dashboard

Add these queries to your monitoring system:

```sql
-- Table sizes (monitor growth)
SELECT
  tablename,
  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
FROM pg_tables
WHERE tablename IN ('audit_events', 'page_versions', 'ai_operations')
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;

-- Query performance (track slow queries)
SELECT
  query,
  calls,
  mean_exec_time,
  max_exec_time
FROM pg_stat_statements
WHERE query LIKE '%audit_events%'
ORDER BY mean_exec_time DESC
LIMIT 10;

-- Index usage (verify indexes being used)
SELECT
  indexname,
  idx_scan,
  pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_stat_user_indexes
WHERE tablename IN ('audit_events', 'page_versions', 'ai_operations')
  AND idx_scan = 0  -- Unused indexes
ORDER BY pg_relation_size(indexrelid) DESC;
```

## Environment Variables

Add these to your `.env`:

```env
# Redis (required for caching and async queue)
REDIS_URL=redis://localhost:6379

# Feature flags
AUDIT_CACHE_ENABLED=true
AUDIT_ASYNC_ENABLED=true  # Set to false if not using async queue

# Retention configuration (optional, defaults provided)
AUDIT_HOT_TO_WARM_MONTHS=3
AUDIT_WARM_DELETE_MONTHS=24
```

## Success Metrics

After implementing Phase 1, you should see:

| Metric | Target | How to Measure |
|--------|--------|----------------|
| Drive activity query time | <50ms (p95) | Check API response times |
| Cache hit ratio | >70% | `getAuditCacheStats()` |
| Database load reduction | >50% | Monitor DB CPU/connections |
| Index usage | All new indexes used | `pg_stat_user_indexes` |

## Troubleshooting

### Slow Queries After Index Migration

```sql
-- Update statistics (indexes need current stats)
ANALYZE audit_events;
ANALYZE page_versions;
ANALYZE ai_operations;

-- Verify index is being used
EXPLAIN ANALYZE SELECT ... ;
```

### Cache Not Working

```typescript
// Check if Redis is connected
import { getRedisClient } from '@pagespace/lib/audit/cache';
const redis = getRedisClient();
console.log('Redis connected:', redis !== null);

// Check cache stats
const stats = await getAuditCacheStats();
console.log('Cache enabled:', stats.totalKeys > 0);
```

### High Queue Backlog

```typescript
// Check queue stats
const stats = await getAuditQueueStats();
console.log('Queue backlog:', stats.waiting);

// If backlog is high:
// 1. Check worker is running
// 2. Increase concurrency in worker config
// 3. Scale horizontally (add more workers)
```

## Rollback

If you need to rollback any component:

```sql
-- Rollback indexes (non-blocking)
DROP INDEX CONCURRENTLY audit_events_drive_action_created_idx;
-- ... drop other indexes as needed

-- Revert autovacuum settings
ALTER TABLE audit_events RESET (autovacuum_vacuum_scale_factor);
```

```env
# Disable features
AUDIT_CACHE_ENABLED=false
AUDIT_ASYNC_ENABLED=false
```

## Next Steps

1. ✅ **Phase 1 (Week 1)**: Apply indexes + enable caching
2. ⏰ **Phase 2 (Week 2-3)**: Implement async queue (optional, for high load)
3. ⏰ **Phase 3 (Month 2)**: Add table partitioning (when audit_events > 10M rows)
4. ⏰ **Phase 4 (Month 3)**: Enable retention policy (when audit_events > 50M rows)

## Additional Resources

- **Full Analysis**: `docs/3.0-guides-and-tools/audit-performance-analysis.md`
- **Implementation Summary**: `AUDIT_PERFORMANCE_OPTIMIZATION_SUMMARY.md`
- **Migration SQL**: `packages/db/drizzle/migrations/audit_performance_optimizations.sql`
- **Cache Implementation**: `packages/lib/src/audit/cache.ts`
- **Async Queue**: `packages/lib/src/audit/async-queue.ts`
- **Retention Script**: `scripts/audit-retention-job.ts`
