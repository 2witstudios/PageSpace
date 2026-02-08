# Review Vector: XSS Prevention

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- security.mdc
- ui.mdc

## Scope
**Files**: `apps/web/src/components/**`, `apps/web/src/lib/canvas/**`
**Level**: domain

## Context
PageSpace uses React which auto-escapes JSX interpolation, but the application includes several high-risk rendering contexts: TipTap rich text editor output, canvas dashboards that render user-authored HTML/CSS within Shadow DOM boundaries, and Monaco editor content display. Review all uses of dangerouslySetInnerHTML, innerHTML assignment, and document.write or equivalent DOM manipulation. Examine whether the Shadow DOM canvas sanitization strips event handlers, javascript: URIs, and data: URI payloads, and whether the sanitizer is applied consistently before every render rather than only at save time.
