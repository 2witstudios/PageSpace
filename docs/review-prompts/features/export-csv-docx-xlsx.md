# Review Vector: Export (CSV, DOCX, XLSX)

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- api-routes.mdc

## Scope
**Files**: `apps/web/src/app/api/pages/[pageId]/export/**`, `apps/web/src/app/api/activities/export/**`
**Level**: domain

## Context
Export endpoints generate CSV, DOCX, and XLSX files from page content and activity data, requiring correct content-type headers and streaming responses for large datasets. The API must await async params per Next.js 15 patterns and verify the user has read access before generating exports. Data transformation logic must handle edge cases like empty content, special characters, and mixed content types without producing corrupted output files.
