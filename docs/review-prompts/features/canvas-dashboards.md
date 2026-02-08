# Review Vector: Canvas Dashboards

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- canvas.mdc
- security.mdc

## Scope
**Files**: `apps/web/src/components/canvas/**`, `apps/web/src/lib/canvas/**`
**Level**: domain

## Context
Canvas pages render custom HTML/CSS widgets inside Shadow DOM containers for style isolation and security sandboxing. All user-provided HTML must pass through security sanitization to prevent XSS and script injection. The canvas system supports navigation between dashboard widgets and must handle dynamic content rendering without leaking styles or event handlers into the parent document.
