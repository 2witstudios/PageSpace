# Review Vector: Pages Routes

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- stack.mdc

## Scope
**Files**: `apps/web/src/app/api/pages/**/route.ts`
**Level**: route

## Context
Pages routes are the largest API surface, covering page CRUD, tree structure retrieval, bulk operations (move, copy, delete), reordering, version history with comparison, export to CSV/DOCX/XLSX, per-page permissions and permission checks, breadcrumbs, children listing, restore from trash, reprocessing triggers, AI usage tracking, agent configuration, and view tracking. The permission model is layered (drive membership plus page-level overrides), so every endpoint must call the centralized permissions module and respect inherited access levels. Bulk operations need transactional consistency and proper authorization checks across all affected pages.
