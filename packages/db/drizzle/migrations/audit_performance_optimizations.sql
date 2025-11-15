-- Audit Performance Optimizations
-- Generated: 2025-11-15
-- Purpose: Add optimized composite indexes and vacuum tuning for enterprise-scale audit trail

-- ====================================================================================
-- COMPOSITE INDEXES FOR COMMON QUERY PATTERNS
-- ====================================================================================

-- Drive activity feed optimizations
-- Supports: getDriveActivityFeed with action type filter
CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_events_drive_action_created_idx
ON audit_events (drive_id, action_type, created_at DESC)
WHERE drive_id IS NOT NULL;

-- Supports: getDriveActivityFeed with AI/human filter
CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_events_drive_ai_created_idx
ON audit_events (drive_id, is_ai_action, created_at DESC)
WHERE drive_id IS NOT NULL;

-- ====================================================================================
-- PARTIAL INDEXES FOR COMMON FILTERS
-- ====================================================================================

-- Supports: getDriveHumanActivity (filters out AI actions)
-- Smaller index, faster queries for human-only activity feeds
CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_events_human_drive_idx
ON audit_events (drive_id, created_at DESC)
WHERE is_ai_action = false AND drive_id IS NOT NULL;

-- Supports: getDriveAiActivity (filters out human actions)
-- Smaller index, faster queries for AI-only activity feeds
CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_events_ai_drive_idx
ON audit_events (drive_id, created_at DESC)
WHERE is_ai_action = true AND drive_id IS NOT NULL;

-- ====================================================================================
-- ADMIN EXPORT OPTIMIZATIONS
-- ====================================================================================

-- Supports: Admin export with user + drive filters
CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_events_user_drive_created_idx
ON audit_events (user_id, drive_id, created_at DESC)
WHERE user_id IS NOT NULL;

-- Supports: Action type analysis across all drives
CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_events_action_created_idx
ON audit_events (action_type, created_at DESC);

-- ====================================================================================
-- AI COST ANALYSIS OPTIMIZATIONS
-- ====================================================================================

-- Supports: Cost analysis by provider/model over time
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_operations_provider_model_created_idx
ON ai_operations (provider, model, created_at DESC);

-- Supports: User AI spending analysis with cost data
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_operations_user_cost_idx
ON ai_operations (user_id, created_at DESC)
INCLUDE (total_cost, input_tokens, output_tokens);

-- Supports: Successful AI operations only (filters out failures)
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_operations_successful_user_idx
ON ai_operations (user_id, created_at DESC)
WHERE status = 'completed';

-- ====================================================================================
-- JSONB INDEXES FOR METADATA QUERIES
-- ====================================================================================

-- Supports: Searching within audit event metadata
-- Example: metadata->'request_source' = 'api'
CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_events_metadata_gin_idx
ON audit_events USING GIN (metadata)
WHERE metadata IS NOT NULL;

-- Supports: Searching within audit event changes
-- Example: changes->'title'->>'after' LIKE '%search%'
CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_events_changes_gin_idx
ON audit_events USING GIN (changes)
WHERE changes IS NOT NULL;

-- Supports: Searching AI tool usage
-- Example: tools_called @> '[{"name": "search_pages"}]'
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_operations_tools_gin_idx
ON ai_operations USING GIN (tools_called)
WHERE tools_called IS NOT NULL;

-- Supports: Searching AI action results
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_operations_actions_gin_idx
ON ai_operations USING GIN (actions_performed)
WHERE actions_performed IS NOT NULL;

-- ====================================================================================
-- PAGE VERSIONS OPTIMIZATIONS
-- ====================================================================================

-- Supports: Finding AI-generated versions for a page
CREATE INDEX CONCURRENTLY IF NOT EXISTS page_versions_page_ai_idx
ON page_versions (page_id, created_at DESC)
WHERE is_ai_generated = true;

-- Supports: Finding user-edited versions for a page
CREATE INDEX CONCURRENTLY IF NOT EXISTS page_versions_page_user_idx
ON page_versions (page_id, created_at DESC)
WHERE is_ai_generated = false;

-- ====================================================================================
-- AUTOVACUUM TUNING FOR HIGH-WRITE TABLES
-- ====================================================================================

-- audit_events: High write frequency, aggressive vacuum needed
ALTER TABLE audit_events SET (
  autovacuum_vacuum_scale_factor = 0.01,      -- Vacuum at 1% dead tuples
  autovacuum_analyze_scale_factor = 0.005,    -- Analyze at 0.5% changes
  autovacuum_vacuum_cost_delay = 10,          -- Speed up vacuum
  autovacuum_vacuum_cost_limit = 1000,        -- Higher I/O budget for vacuum
  autovacuum_naptime = 60                     -- Check every 60 seconds
);

-- page_versions: Medium write frequency, moderate vacuum
ALTER TABLE page_versions SET (
  autovacuum_vacuum_scale_factor = 0.05,      -- Vacuum at 5% dead tuples
  autovacuum_analyze_scale_factor = 0.02,     -- Analyze at 2% changes
  autovacuum_vacuum_cost_delay = 20,
  autovacuum_vacuum_cost_limit = 500
);

-- ai_operations: High write frequency, aggressive vacuum needed
ALTER TABLE ai_operations SET (
  autovacuum_vacuum_scale_factor = 0.01,      -- Vacuum at 1% dead tuples
  autovacuum_analyze_scale_factor = 0.005,    -- Analyze at 0.5% changes
  autovacuum_vacuum_cost_delay = 10,
  autovacuum_vacuum_cost_limit = 1000,
  autovacuum_naptime = 60
);

-- ====================================================================================
-- STATISTICS TARGETS FOR BETTER QUERY PLANNING
-- ====================================================================================

-- Increase statistics target for frequently filtered columns
ALTER TABLE audit_events ALTER COLUMN drive_id SET STATISTICS 1000;
ALTER TABLE audit_events ALTER COLUMN user_id SET STATISTICS 1000;
ALTER TABLE audit_events ALTER COLUMN action_type SET STATISTICS 500;
ALTER TABLE audit_events ALTER COLUMN created_at SET STATISTICS 1000;

ALTER TABLE page_versions ALTER COLUMN page_id SET STATISTICS 1000;
ALTER TABLE page_versions ALTER COLUMN created_at SET STATISTICS 500;

ALTER TABLE ai_operations ALTER COLUMN user_id SET STATISTICS 1000;
ALTER TABLE ai_operations ALTER COLUMN drive_id SET STATISTICS 1000;
ALTER TABLE ai_operations ALTER COLUMN provider SET STATISTICS 500;
ALTER TABLE ai_operations ALTER COLUMN model SET STATISTICS 500;

-- ====================================================================================
-- ANALYZE TABLES TO UPDATE STATISTICS
-- ====================================================================================

ANALYZE audit_events;
ANALYZE page_versions;
ANALYZE ai_operations;

-- ====================================================================================
-- VERIFICATION QUERIES
-- ====================================================================================

-- Verify indexes created
SELECT
  schemaname,
  tablename,
  indexname,
  pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
FROM pg_stat_user_indexes
WHERE tablename IN ('audit_events', 'page_versions', 'ai_operations')
  AND schemaname = 'public'
ORDER BY tablename, indexname;

-- Verify autovacuum settings
SELECT
  relname,
  reloptions
FROM pg_class
WHERE relname IN ('audit_events', 'page_versions', 'ai_operations');

-- ====================================================================================
-- NOTES
-- ====================================================================================

-- Index Creation Time:
--   - CONCURRENTLY avoids table locks but takes longer
--   - Estimated time: 5-30 minutes depending on table size
--   - Can be run on production without downtime

-- Storage Impact:
--   - New indexes will increase storage by ~20-30%
--   - GIN indexes are larger but enable fast JSONB queries
--   - Partial indexes are smaller than full indexes

-- Performance Impact:
--   - Queries using new indexes: 2-10x faster
--   - Write performance: ~5-10% slower (more indexes to maintain)
--   - Overall: Net positive (reads far outnumber writes)

-- Maintenance:
--   - Autovacuum is tuned to be more aggressive
--   - Consider REINDEX CONCURRENTLY monthly to prevent bloat
--   - Monitor index usage with pg_stat_user_indexes
