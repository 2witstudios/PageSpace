# Review Vector: Output Encoding

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- security.mdc

## Scope
**Files**: `apps/web/src/components/**`, `apps/web/src/lib/canvas/**`
**Level**: domain

## Context
PageSpace renders user-generated content across multiple surfaces including rich text documents, canvas dashboards with Shadow DOM isolation, and various component displays. Review how user-supplied content is encoded before rendering, particularly in contexts where raw HTML may be injected. Examine the canvas system's sanitization pipeline and whether Shadow DOM boundaries actually prevent script execution or merely provide style isolation.
