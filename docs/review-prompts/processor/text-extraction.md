# Review Vector: Text Extraction

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)

## Scope
**Files**: `apps/processor/src/services/**`, `apps/processor/src/workers/**`
**Level**: service

## Context
The processor service extracts text content from PDFs and other document formats to enable search indexing and AI context retrieval. Review that extraction handles malformed documents gracefully, respects memory limits on large files, and produces clean text output. Verify that extracted content is correctly associated with the source file's metadata record.
