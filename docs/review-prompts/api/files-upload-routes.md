# Review Vector: Files & Upload Routes

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- stack.mdc

## Scope
**Files**: `apps/web/src/app/api/files/**/route.ts`, `apps/web/src/app/api/upload/**/route.ts`
**Level**: route

## Context
File routes handle download, view (inline rendering), and conversion of uploaded files to document pages. The upload route accepts multipart form data and coordinates with the processor service for image optimization and content extraction. File access must be gated by page-level permissions since files are attached to pages. The convert-to-document endpoint transforms file content into editable page content, requiring careful handling of file types and content sanitization to prevent XSS through uploaded HTML or SVG files.
