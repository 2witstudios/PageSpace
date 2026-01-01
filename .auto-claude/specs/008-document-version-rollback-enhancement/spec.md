# Specification: Document Version Rollback Enhancement

## Overview

This feature enhances the existing document version history and rollback system to provide robust visual diff capabilities, support for all content types including embedded files, and selective rollback functionality. The enhancement addresses current limitations in version control to build user trust and enable safe experimentation in collaborative editing environments.

## Workflow Type

**Type**: feature

**Rationale**: This is a new feature enhancement that extends existing version control capabilities with visual diff comparison, comprehensive content type support, and granular rollback controls. It builds upon the existing `pageVersions` infrastructure while adding significant new functionality.

## Task Scope

### Services Involved
- **web** (primary) - Next.js frontend and API routes for version management
- **db** (integration) - Database schema and queries for version storage
- **lib** (integration) - Shared utilities for compression and content handling

### This Task Will:
- [ ] Implement visual diff comparison between any two document versions
- [ ] Add support for embedded file handling in version rollback
- [ ] Enable partial/selective rollback of specific document sections
- [ ] Implement compression for efficient storage of large document versions
- [ ] Add 30-day version retention policy enforcement
- [ ] Create UI components for version comparison and rollback

### Out of Scope:
- Modifications to the Tiptap editor core functionality
- Changes to the realtime collaboration system
- Desktop app version history integration
- Version history for non-page content types

## Service Context

### web (Next.js Frontend)

**Tech Stack:**
- Language: TypeScript
- Framework: Next.js (v15.3.6) with App Router
- Styling: Tailwind CSS
- State Management: Zustand
- Key directories: src/app (routes), src/components (UI)

**Entry Point:** `src/app/page.tsx`

**How to Run:**
```bash
npm run dev
```

**Port:** 3000

### db (Database Package)

**Tech Stack:**
- Language: JavaScript/TypeScript
- ORM: Drizzle (v0.32.2)
- Database: PostgreSQL (v8.16.3)
- Key directories: src/schema (database schemas)

**Entry Point:** `src/index.ts`

**How to Run:**
```bash
# Migrations run via docker-compose
docker-compose up migrate
```

### lib (Shared Library)

**Tech Stack:**
- Language: JavaScript/TypeScript
- Framework: React utilities
- Key directories: src/content (content utilities)

**Entry Point:** `src/index.ts`

## Files to Modify

| File | Service | What to Change |
|------|---------|---------------|
| `packages/db/src/schema/versioning.ts` | db | Add compression metadata fields, retention policy fields |
| `apps/web/src/app/api/pages/[pageId]/history/route.ts` | web | Extend to support diff generation, selective rollback |
| `apps/web/src/app/api/pages/[pageId]/versions/route.ts` | web | Create new endpoint for version operations (compare, restore) |
| `packages/lib/src/content/page-content-format.ts` | lib | Add diff utilities for different content formats |

## Files to Reference

These files show patterns to follow:

| File | Pattern to Copy |
|------|----------------|
| `packages/db/src/schema/versioning.ts` | Drizzle schema patterns, JSONB metadata handling |
| `apps/web/src/app/api/pages/[pageId]/history/route.ts` | Next.js App Router API patterns, NextResponse usage |
| `packages/lib/src/content/page-content-format.ts` | Content format handling patterns |

## Patterns to Follow

### Database Schema Pattern

From `packages/db/src/schema/versioning.ts`:

**Key Points:**
- Use Drizzle ORM schema definition patterns
- Store compressed content via `contentRef` (not inline)
- Use JSONB columns for flexible metadata storage
- Leverage existing `expiresAt` field for retention policy
- Import pattern: `import { db, pageVersions } from '@pagespace/db'`

### API Route Pattern

From existing API routes:

**Key Points:**
- Follow Next.js 15 App Router conventions: `app/api/pages/[pageId]/versions/...`
- Use `NextResponse` for route handlers
- Server Components are default in Next.js 15
- Database queries use Drizzle patterns: `db.select()`, `db.insert().values().returning()`

### Content Format Handling

From `packages/lib/src/content/page-content-format.ts`:

**Key Points:**
- Multiple content formats supported: HTML, Markdown, JSON
- Rich text must be handled properly in diff visualization
- Tiptap v3.x API differences from v2 (major version)

## Requirements

### Functional Requirements

1. **Visual Diff Comparison**
   - Description: Users can select any two versions and view a visual diff showing exact changes
   - Acceptance: Side-by-side or unified diff view showing additions, deletions, and modifications between any two selected versions

2. **Comprehensive Rollback Support**
   - Description: Rollback handles all content types including text, formatting, and embedded files
   - Acceptance: Successfully restore previous versions containing embedded files, images, and rich formatting without data loss

3. **Selective Rollback**
   - Description: Users can revert specific sections or changes without affecting unrelated content
   - Acceptance: UI allows selection of specific paragraphs/sections to rollback while preserving other recent changes

4. **Version Retention Policy**
   - Description: Maintain version history for minimum 30 days across all pricing plans
   - Acceptance: Versions are automatically retained for at least 30 days, with `expiresAt` field properly set

5. **Storage Optimization**
   - Description: Large document versions are compressed for efficient storage
   - Acceptance: Versions use verified compression library (e.g., pako after npm verification), reducing storage size while maintaining quick decompression for viewing

### Edge Cases

1. **Embedded File References** - Ensure embedded file references remain valid after rollback; handle cases where embedded files were deleted between versions
2. **Large Documents** - Test with documents >1MB to verify compression works efficiently; for very large documents (>5MB), diff computation should use streaming to prevent memory exhaustion
3. **Concurrent Edits** - Handle version creation during active collaborative editing sessions
4. **Corrupted Versions** - Gracefully handle versions with missing or corrupted data
5. **Retention Boundary** - Properly clean up versions older than 30 days without affecting recent versions
6. **Diff Performance** - Implement caching for frequently compared version pairs to avoid redundant computation

## Implementation Notes

### DO
- Follow the Drizzle ORM pattern in `packages/db/src/schema/versioning.ts` for schema changes
- Reuse existing `pageVersions` table structure, extend with new metadata fields
- **CRITICAL**: Verify package compatibility before implementation:
  - Verify `pako` package for compression (currently UNVERIFIED - check npm for API and compatibility)
  - Verify `diff` or similar package for text diffing (currently UNVERIFIED - check npm for React 19 compatibility)
  - Verify React diff viewer component (e.g., `react-diff-viewer` or `react-diff-view`) for React 19 compatibility and bundle size impact
- Use verified compression library (e.g., pako after verification) for compression/decompression of version content
- Implement diff generation server-side for security and performance
- Store compressed content via `contentRef` to separate storage (not inline DB)
- Use React 19-compatible components for diff viewer UI (verify compatibility first)
- Follow Next.js 15 App Router conventions for new API endpoints
- Consider implementing diff result caching to avoid recomputing frequently compared versions
- For very large documents (>5MB), consider streaming diff computation to avoid memory issues

### DON'T
- Create new version storage tables when `pageVersions` already exists
- Store uncompressed content for large documents
- Implement diff logic in client-side code (security risk)
- Break backwards compatibility with existing version history
- Use Tiptap v2 APIs (project uses v3.x)
- Ignore the pinned Drizzle version (0.32.2) in pnpm overrides

## Development Environment

### Start Services

```bash
# Start PostgreSQL and Redis via Docker
docker-compose up postgres redis

# Run database migrations
docker-compose up migrate

# Start Next.js web app (development mode)
cd apps/web
npm run dev

# Optional: Start processor service if testing embedded files
cd apps/processor
npm run dev
```

### Service URLs
- Web App: http://localhost:3000
- Processor: http://localhost:3003
- PostgreSQL: localhost:5432
- Redis: localhost:6379

### Required Environment Variables
- `DATABASE_URL`: postgresql://user:password@localhost:5432/pagespace
- `JWT_SECRET`: Required for authentication
- `JWT_ISSUER`: pagespace
- `JWT_AUDIENCE`: pagespace-users
- `ENCRYPTION_KEY`: Required for secure data
- `CSRF_SECRET`: Required for CSRF protection
- `FILE_STORAGE_PATH`: ./storage (for embedded files)

## Success Criteria

The task is complete when:

1. [ ] All unverified packages (pako, diff library, React diff viewer) verified for compatibility and installed
2. [ ] Users can select any two versions and view a visual diff (split or unified view)
3. [ ] Rollback successfully restores versions containing embedded files without data loss
4. [ ] Selective rollback UI allows choosing specific sections to revert
5. [ ] Version retention policy enforces 30-day minimum retention
6. [ ] Large documents (>1MB) are compressed using verified compression library
7. [ ] No console errors in browser or server logs
8. [ ] Existing tests still pass
9. [ ] New functionality verified via browser testing
10. [ ] Version comparison performs efficiently (<2s for typical documents)
11. [ ] Backwards compatibility maintained with existing version history

## QA Acceptance Criteria

**CRITICAL**: These criteria must be verified by the QA Agent before sign-off.

### Unit Tests
| Test | File | What to Verify |
|------|------|----------------|
| Version compression/decompression | `packages/lib/src/content/__tests__/compression.test.ts` | Verified compression library correctly compresses and decompresses content without data loss |
| Diff generation for HTML content | `packages/lib/src/content/__tests__/diff.test.ts` | Diff algorithm correctly identifies additions, deletions, modifications |
| Version retention policy | `packages/db/src/__tests__/versioning.test.ts` | `expiresAt` field is set correctly to 30 days from creation |
| Selective rollback logic | `apps/web/src/lib/__tests__/version-rollback.test.ts` | Section selection and partial restoration works correctly |

### Integration Tests
| Test | Services | What to Verify |
|------|----------|----------------|
| Version creation with compression | web ↔ db | Versions are saved with compressed content and proper metadata |
| Version comparison API | web ↔ db | API returns correct diff between two versions |
| Rollback with embedded files | web ↔ db ↔ processor | Embedded file references remain valid after rollback |
| Version cleanup job | web ↔ db | Versions older than 30 days are properly expired |

### End-to-End Tests
| Flow | Steps | Expected Outcome |
|------|-------|------------------|
| View version diff | 1. Open document with 3+ versions 2. Select two versions 3. Click "Compare" | Split/unified diff view shows exact changes between versions |
| Full rollback | 1. Open version history 2. Select older version 3. Click "Restore" | Document content reverts to selected version, including formatting and embedded files |
| Selective rollback | 1. Open version comparison 2. Select specific sections 3. Click "Restore Selected" | Only selected sections are reverted, other content remains unchanged |
| Large document handling | 1. Create version of 2MB document 2. View version history | Version saves successfully with compression, loads quickly |

### Browser Verification (Frontend)
| Page/Component | URL | Checks |
|----------------|-----|--------|
| Version History Panel | `http://localhost:3000/pages/[pageId]` | Version list displays with timestamps, user info, compressed size |
| Version Comparison View | `http://localhost:3000/pages/[pageId]/compare?v1=X&v2=Y` | Diff viewer shows additions (green), deletions (red), unchanged (gray) |
| Rollback Confirmation Dialog | Triggered from version history | Warning message, preview of changes, confirm/cancel buttons |
| Selective Rollback UI | Within version comparison | Checkboxes/selection for individual sections/paragraphs |

### Database Verification
| Check | Query/Command | Expected |
|-------|---------------|----------|
| Compression metadata exists | `SELECT metadata FROM "pageVersions" WHERE id = 'test-version-id'` | JSONB contains `{ "compressed": true, "compressionRatio": X }` |
| Retention policy applied | `SELECT "expiresAt" FROM "pageVersions" WHERE id = 'new-version-id'` | `expiresAt` is ~30 days from `createdAt` |
| Content stored via contentRef | `SELECT "contentRef" FROM "pageVersions" WHERE id = 'test-id'` | `contentRef` points to compressed content in storage, not inline |
| Old versions expired | `SELECT COUNT(*) FROM "pageVersions" WHERE "expiresAt" < NOW()` | Count matches expected expired versions |

### Performance Benchmarks
| Metric | Threshold | How to Measure |
|--------|-----------|----------------|
| Diff generation time | < 2 seconds for 100KB document | Time API response for `/api/pages/[id]/versions/compare` |
| Compression ratio | > 50% reduction for text-heavy docs | Compare original size to compressed size in metadata |
| Rollback operation time | < 3 seconds for typical document | Measure time from restore click to UI update |
| Version history load time | < 1 second for 50 versions | Measure API response for `/api/pages/[id]/history` |

### QA Sign-off Requirements
- [ ] All unit tests pass with >80% coverage for new code
- [ ] All integration tests pass
- [ ] All E2E tests pass in Chrome and Firefox
- [ ] Browser verification complete for all listed components
- [ ] Database verification confirms proper schema usage
- [ ] Performance benchmarks meet or exceed thresholds
- [ ] No regressions in existing version history functionality
- [ ] Code follows Drizzle ORM and Next.js App Router patterns
- [ ] No security vulnerabilities (embedded file handling is secure)
- [ ] Backwards compatibility verified with existing version data
- [ ] Documentation updated for new API endpoints
- [ ] Error handling verified for edge cases (corrupted versions, missing files)
