# Review Vector: Performance Architecture

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- stack.mdc

## Scope
**Files**: `apps/web/src/app/**`, `apps/web/next.config.*`
**Level**: architectural

## Context
Next.js 15 App Router enables server components by default, with client components opted in via "use client" directives. This boundary determines bundle size, rendering strategy, and data fetching patterns. Review whether server and client component boundaries are drawn at the right level, whether heavy dependencies are kept out of client bundles, and whether caching, lazy loading, and streaming are leveraged where they would meaningfully improve user experience.
