# Review Vector: Export Document

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- requirements.mdc
- productmanager.mdc

## Scope
**Files**: `apps/web/src/app/api/pages/[pageId]/export/docx/route.ts`, `apps/web/src/app/api/pages/[pageId]/export/csv/route.ts`, `apps/web/src/app/api/pages/[pageId]/export/xlsx/route.ts`, `apps/web/src/app/api/pages/[pageId]/route.ts`, `packages/lib/src/permissions/permissions.ts`, `packages/db/src/schema/core.ts`
**Level**: domain

## Context
The export journey begins when a user selects an export format (DOCX, CSV, or XLSX) from the page actions menu. The corresponding export API route validates the user's read permission on the page, fetches the page content from the database, transforms it into the requested format using server-side document generation libraries, and returns the file as a downloadable response with appropriate content-type headers. This flow crosses the frontend action trigger, API route handlers with Next.js 15 async params, permission enforcement, database content retrieval, and data transformation to multiple output formats.
