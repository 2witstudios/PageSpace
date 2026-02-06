# Review Vector: CORS Origin Validation

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- security.mdc

## Scope
**Files**: `apps/web/next.config.*`, `apps/web/src/middleware.ts`, `apps/realtime/src/**`
**Level**: service

## Context
CORS policies govern which origins can make credentialed requests to the web API and the realtime Socket.IO service, both of which handle sensitive operations. Review the origin allowlist implementation for overly permissive patterns such as wildcard origins with credentials, regex-based matching that can be bypassed with subdomain tricks, or null origin acceptance. Examine whether preflight responses correctly restrict methods and headers, and whether the realtime service enforces the same origin policy as the web application or operates with a more permissive configuration.
