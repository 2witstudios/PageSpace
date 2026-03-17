# Decouple NEXT_PUBLIC_ Build-Time Vars Epic

**Status**: PLANNED
**Goal**: Build web image once, run it with any tenant's config via runtime env vars only

## Overview

Next.js inlines `NEXT_PUBLIC_*` vars at build time, meaning a different image build is needed per tenant if those vars differ. The primary offender is `NEXT_PUBLIC_REALTIME_URL` which currently points Socket.IO to a separate origin. By routing `/socket.io` through the same origin via Traefik (Epic 3), this var becomes unnecessary. This epic makes the web Docker image fully reusable across tenants by eliminating tenant-specific build-time vars.

---

## Socket.IO Same-Origin Fallback

Modify the socket store to default to same-origin when `NEXT_PUBLIC_REALTIME_URL` is empty/undefined.

**Requirements**:
- Given `NEXT_PUBLIC_REALTIME_URL` is undefined, should call `io(undefined, opts)` which connects to `window.location.origin`
- Given `NEXT_PUBLIC_REALTIME_URL` is set to a URL, should continue using that URL (backward compat for dev/existing deployments)
- Given a desktop Electron client, should still resolve the realtime URL from `PAGESPACE_URL` or same-origin
- Given the existing reconnection config, should preserve all reconnection settings unchanged

**TDD Approach**:
- Write unit tests in `apps/web/src/stores/__tests__/useSocketStore.test.ts`
- Mock `io` from `socket.io-client` and assert the first argument passed
- Given `NEXT_PUBLIC_REALTIME_URL` is `undefined`, should pass `undefined` as first arg to `io()`
- Given `NEXT_PUBLIC_REALTIME_URL` is `"https://rt.example.com"`, should pass that URL as first arg

**Key file**: `apps/web/src/stores/useSocketStore.ts` (line 59, line 89)

---

## Dockerfile ARG Defaults

Make `NEXT_PUBLIC_REALTIME_URL` optional in the web Dockerfile so it can be omitted during build.

**Requirements**:
- Given no `NEXT_PUBLIC_REALTIME_URL` build arg, should build successfully with empty default
- Given `NEXT_PUBLIC_APP_URL` build arg, should continue inlining it (only used as server-side fallback with `WEB_APP_URL ||` prefix)
- Given `NEXT_PUBLIC_STORAGE_MAX_FILE_SIZE_MB` build arg, should continue inlining (same across all tenants)
- Given `NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID` build arg, should continue inlining (same across all tenants)

**TDD Approach**:
- Write a validation test (`infrastructure/scripts/__tests__/dockerfile-args.test.ts`) that parses the Dockerfile
- Given the Dockerfile, should have `ARG NEXT_PUBLIC_REALTIME_URL` with no default or empty default
- Given the Dockerfile, should NOT have any tenant-specific secrets as ARGs

**Key file**: `apps/web/Dockerfile` (lines 36-46)

---

## Verify NEXT_PUBLIC_APP_URL Server-Side Only Usage

Audit and confirm `NEXT_PUBLIC_APP_URL` is never the sole URL source on the client.

**Requirements**:
- Given all usages of `NEXT_PUBLIC_APP_URL` in the codebase, should always have a `WEB_APP_URL ||` prefix or be server-side only
- Given a client component importing `NEXT_PUBLIC_APP_URL`, should flag as a build-time dependency to address
- Given the audit completes clean, should document the finding as a code comment in deployment-mode.ts

**TDD Approach**:
- Write a grep-based lint test (`infrastructure/scripts/__tests__/env-var-audit.test.ts`)
- Given client-side files (`.tsx` in `app/` or `components/`), should not use `NEXT_PUBLIC_APP_URL` without server-side guard
- Given server-side files (route handlers, middleware), usage of `NEXT_PUBLIC_APP_URL` is acceptable
