# Review Vector: Upload and View File

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- requirements.mdc
- productmanager.mdc

## Scope
**Files**: `apps/web/src/app/api/upload/route.ts`, `apps/web/src/app/api/files/[id]/view/route.ts`, `apps/web/src/app/api/files/[id]/download/route.ts`, `apps/web/src/app/api/pages/[pageId]/processing-status/route.ts`, `apps/processor/src/api/upload.ts`, `apps/processor/src/api/serve.ts`, `apps/processor/src/api/optimize.ts`, `apps/processor/src/workers/image-processor.ts`, `apps/processor/src/workers/text-extractor.ts`, `apps/processor/src/cache/content-store.ts`, `packages/db/src/schema/storage.ts`, `apps/web/src/hooks/useFileDrop.ts`
**Level**: domain

## Context
The upload journey starts with the useFileDrop hook capturing a file, which POSTs to the upload API route. The web app forwards the file to the processor service which stores it in the content-addressed file system, generates thumbnails via the image processor, extracts text content, and updates the database with file metadata. The frontend polls the processing-status endpoint until complete, then renders the file through the view route. This flow spans the web frontend, Next.js API routes, the standalone processor service, queue-based background workers, filesystem storage, and database metadata tracking.
