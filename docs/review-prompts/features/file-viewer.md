# Review Vector: File Viewer

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- editor.mdc

## Scope
**Files**: `apps/web/src/components/**` (viewer components)
**Level**: domain

## Context
File preview components handle images, PDFs, and code files with Monaco Editor for syntax-highlighted code viewing. Each viewer type must gracefully handle loading states, errors, and unsupported formats with clear user feedback. The code viewer integrates Monaco in read-only mode while the image viewer handles responsive sizing and zoom controls.
