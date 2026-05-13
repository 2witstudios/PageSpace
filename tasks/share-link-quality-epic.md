# Epic: Share Link Code Quality

## Background

The share link flow has several code-quality issues identified in a review: over-abstracted generic hook with unsafe type casts, CSRF-error used as an auth-state proxy, a fragile ref guard for idempotency, swallowed audit-log errors, and inconsistent error handling in the accept route.

## Requirements

1. **Given a driveId, `useDriveShareLink` should load an existing link and expose `shareUrl` without runtime type casts** — API response is validated with a schema; `shareUrl` is null for links without a stored token.

2. **Given a pageId, `usePageShareLink` should load an existing link and expose `shareUrl` without runtime type casts** — API response is validated with a schema.

3. **Given a drive share link is generated, `useDriveShareLink` should update `activeLink` from the full POST response, not from captured closure state** — no `buildNewLink` factory passed from the call site.

4. **Given a page share link is generated, `usePageShareLink` should update `activeLink` from the full POST response** — no `buildNewLink` factory.

5. **Given an unauthenticated user visits a drive share link, `DriveShareAccept` should redirect to `/auth/signin?next=…` based on `isAuthenticated` from `useAuth`, not CSRF error state.**

6. **Given an unauthenticated user visits a page share link, `PageShareAccept` should redirect to `/auth/signin?next=…` based on `isAuthenticated` from `useAuth`, not CSRF error state.**

7. **Given `PageShareAccept` fires the accept effect twice (React StrictMode), only one request should reach the server** — use an AbortController, not a ref guard.

8. **Given share link redemption succeeds but the audit log write fails, the accept route should log the audit error instead of swallowing it with `catch(() => undefined)`.**

9. **Given share link redemption succeeds but `emitAcceptanceSideEffects` fails, the accept route should log the error.**

10. **Given the drive redemption endpoint returns an error other than `NOT_FOUND`, the accept route should return 500 without attempting page redemption** — current behaviour is correct; this requirement documents the existing asymmetry so it is intentional, not accidental.
