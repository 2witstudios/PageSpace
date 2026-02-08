# Review Vector: Auth Routes

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- stack.mdc

## Scope
**Files**: `apps/web/src/app/api/auth/**/route.ts`
**Level**: route

## Context
These routes handle the entire authentication surface: email/password login, signup, email verification, Google and Apple OAuth flows (web and native), mobile-specific auth endpoints, desktop token exchange, CSRF token generation, and session management via logout and /me. They also issue Socket.IO and WebSocket tokens for real-time services. Security vulnerabilities here compromise the entire application, so JWT handling, CSRF protection, rate limiting, and proper cookie configuration are critical review targets.
