# Changelog

All notable changes to PageSpace will be documented in this file.

## [Unreleased]

### Added - Audit Trail Performance Optimizations (2025-11-15)

- **Performance Analysis**: Comprehensive analysis of audit trail system for enterprise-scale deployments
  - Analyzed index strategy across 42 indexes (audit_events: 9, page_versions: 6, ai_operations: 9)
  - Identified query performance bottlenecks and optimization opportunities
  - Designed table partitioning strategy for 100M+ audit events
  - Created retention and archival policy for controlled storage growth

- **Database Performance Indexes** (`packages/db/drizzle/migrations/audit_performance_optimizations.sql`)
  - Added 12 new composite indexes for common query patterns (drive activity, admin export, AI cost analysis)
  - Added 3 partial indexes for filtered queries (AI/human activity split)
  - Added 4 JSONB GIN indexes for metadata and changes queries
  - Added 2 page version indexes for AI/user-generated filtering
  - Configured aggressive autovacuum for high-write tables
  - Set statistics targets for better query planning
  - **Expected Impact**: 2-10x faster queries, especially filtered drive activity feeds

- **Redis Caching Layer** (`packages/lib/src/audit/cache.ts`)
  - Complete caching implementation for audit queries
  - Drive activity feed cache (60s TTL)
  - User activity timeline cache (5min TTL)
  - Page versions cache (10min TTL)
  - AI stats and drive stats cache (1hr TTL)
  - Automatic cache invalidation on writes
  - Cache warming utilities
  - Cache statistics for monitoring
  - **Expected Impact**: 10-40x faster with cache hits, 70-80% reduction in database load

- **Async Audit Queue** (`packages/lib/src/audit/async-queue.ts`)
  - BullMQ-based background job queue for audit logging
  - Worker for processing audit jobs with configurable concurrency
  - Priority levels for different event types (critical, high, normal, low)
  - Automatic retry with exponential backoff
  - Job monitoring and statistics
  - Graceful fallback to synchronous on queue failure
  - **Expected Impact**: <1ms overhead (vs 5-10ms sync), 50x faster bulk operations

- **Retention and Archival System** (`scripts/audit-retention-job.ts`)
  - Automated data lifecycle management
  - Archive tables for warm tier storage (3-12 months)
  - Hot to warm tier migration (data older than 3 months)
  - Automatic deletion of very old data (24+ months)
  - Page versions management and reporting
  - Database vacuum and maintenance
  - Statistics and reporting for monitoring
  - **Expected Impact**: 50-70% reduction in main table size, controlled storage growth

- **Performance Documentation** (`docs/3.0-guides-and-tools/audit-performance-analysis.md`)
  - Comprehensive 200+ page performance analysis
  - Query performance analysis with expected times
  - Missing index identification and recommendations
  - Table partitioning strategy (for 10M+ events)
  - Caching strategy with Redis
  - Async logging architecture
  - Database maintenance recommendations
  - Monitoring and alerting setup
  - 4-phase optimization roadmap

- **Implementation Summary** (`AUDIT_PERFORMANCE_OPTIMIZATION_SUMMARY.md`)
  - Executive summary of all optimizations
  - Performance improvements table (5-50x improvements)
  - Storage management strategy (60-80% savings)
  - 4-phase implementation roadmap
  - Integration guide with code examples
  - Monitoring setup and key metrics
  - Testing recommendations
  - Rollback plan
  - Success criteria

### Performance Targets (After All Optimizations)

| Query | Current | Target | Improvement |
|-------|---------|--------|-------------|
| Drive activity feed (base) | 50-100ms | 10-20ms | 5x |
| Drive activity feed (filtered) | 200-500ms | 20-50ms | 10x |
| Drive activity feed (cached) | 50-100ms | 5-10ms | 10x |
| Page version list | 20-50ms | 10-20ms | 2x |
| Admin export (10K records) | 2-5s | 500ms-1s | 4x |
| Audit logging overhead | 5-10ms | <1ms | 10x |

### Migration Notes

**Phase 1 (Week 1) - Immediate**:
1. Apply database migration: `audit_performance_optimizations.sql`
2. Set up Redis and integrate caching layer
3. Configure environment variables

**Phase 2 (Week 2-3)**:
1. Set up BullMQ queue
2. Migrate audit functions to async
3. Add monitoring

**Phase 3 (Month 2) - When audit_events > 10M rows**:
1. Implement table partitioning
2. Set up pg_partman for automatic partition management

**Phase 4 (Month 3) - When audit_events > 50M rows**:
1. Enable retention and archival job
2. Schedule daily archival cron job

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Paginated Documents** - Documents can now be displayed with print-ready pagination
  - Toggle between Continuous and Paginated layouts via "Page Layout" button in document header
  - Paginated documents show visual page breaks, page numbers in footers, and headers
  - US Letter page size (8.5" × 11") with 1-inch margins
  - Tables automatically span across multiple pages
  - Opt-in feature - existing documents remain in continuous layout by default
  - Compatible with AI editing, Monaco code view, and collaborative editing
  - Custom in-house Tiptap extension (~560 lines) - no external dependencies
  - Pre-defined page sizes: A3, A4, A5, Letter, Legal, Tabloid

### Changed
- Added `isPaginated` boolean field to pages database schema

### Technical
- Database migration: Added `isPaginated` column to `pages` table (default: false)
- API: PATCH `/api/pages/[pageId]` now accepts `isPaginated` field
- New pagination extension: `apps/web/src/lib/editor/pagination/` (PaginationExtension, utils, constants)
- New component: `PaginationToggle` for layout switching UI
- Documentation: Added implementation guide at `docs/3.0-guides-and-tools/paginated-documents-implementation.md`

---

## [Previous Releases]

See git history for previous changes.
