# Sentry Crash Reporting Epic

**Live tracking**: PageSpace `Sentry` task list — page `h6z6jafz5no84iu0sjou2kl8` in drive `lng6q95adrfndmdnnf9z8g6p` (`pagespace tasks list h6z6jafz5no84iu0sjou2kl8`). This file is the durable narrative/reference copy; check the PageSpace board for current status.

**Status**: 📋 PLANNED
**Goal**: Fix apps/web's Sentry (currently sends zero alerts in production) and extend crash reporting to realtime, processor, control-plane, and admin, with a fail-loud env check so this can never silently regress.

## Overview

Because the 2026-07-17 solo-tells audit found "no alerting path to a human anywhere" — Sentry is web-only with an optional unvalidated DSN that may be silently off in prod — and the owner confirmed web sends zero alerts today, this epic closes the gap end to end. Root cause (confirmed in code): `SENTRY_DSN` (server/edge, the runtime that catches the most real errors via `onRequestError`) is never set anywhere in the deploy pipeline — not in `fly.web.toml`, not in `setup-fly.sh`, not as a Docker `ARG`/`ENV`. `Sentry.init({dsn: undefined})` silently no-ops with no log line, and `env-validation.ts` has zero awareness of `SENTRY_DSN` so boot-time validation passes clean regardless. Realtime, processor, control-plane, and admin have no Sentry SDK and no global crash handlers of any kind today. Onprem deployments are exempted from the new fail-loud requirement (confirmed with owner) — Sentry is a third-party SaaS integration, and onprem already disables that class of integration (OAuth, external AI, Calendar) per `deployment-mode.ts`.

---

## Phase 1 — Shared building blocks (packages/lib)

Everything else in this epic depends on these three pieces landing first.

### Shared Sentry options helper

Move `getSentryOptions()` out of `apps/web/src/lib/sentry/config.ts` into a new shared module every app can import.

**Requirements**:
- Given the existing web behavior (dsn passthrough, `tracesSampleRate` 1.0 dev / 0.1 prod, `sendDefaultPii` opt-in false by default), the moved function at `packages/lib/src/observability/sentry-env.ts` should preserve it exactly — no behavior change for web.
- Given `packages/lib/package.json`'s `exports` map, a new `./observability/sentry-env` subpath entry should exist so consumers don't hit TS2307.
- Given `apps/web`'s 3 existing Sentry config files and its config test, they should import from the new shared location; the old `apps/web/src/lib/sentry/` dir should be removed once nothing references it.

### Reusable global crash-handler hook

Extend the existing (currently unused-by-any-app) `setupErrorHandlers()`/`initializeLogging()` in `packages/lib/src/logging/logger-config.ts` to accept an optional async callback.

**Requirements**:
- Given `setupErrorHandlers(onFatalError?: (error: unknown) => Promise<void> | void)`, on `uncaughtException` it should await the hook (best-effort, swallowing the hook's own errors) before `process.exit(1)`; on `unhandledRejection` it should await the hook without exiting.
- Given no hook is passed, existing behavior (log via `loggers.system`, exit on uncaught) should be unchanged — this is a backward-compatible extension, not a rewrite.

### Fail-loud SENTRY_DSN validation, onprem-exempt

Add `SENTRY_DSN` awareness to `packages/lib/src/config/env-validation.ts`.

**Requirements**:
- Given `NODE_ENV=production` and `isOnPrem()` is false (cloud/tenant) and `SENTRY_DSN` is unset, `serverEnvSchema`'s `superRefine` should add a validation issue (same style as the existing `CSRF_SECRET`/`ENCRYPTION_KEY` block), so `apps/web`'s existing `validateEnv()` call fails loud at boot.
- Given `isOnPrem()` is true, the same production/missing-DSN condition should NOT fail validation — onprem is exempt by design.
- Given a new standalone exported `requireSentryDsn(serviceName: string): void` doing the identical check via `process.env` directly (not the full schema), it should throw a descriptive error naming the service — this is what realtime/processor/control-plane/admin call, since none of them use the full `serverEnvSchema` today.

---

## Phase 2 — Fix apps/web (the actual root-cause fix)

### Wire the missing DSN + close the error-boundary gaps

**Requirements**:
- Given `SENTRY_DSN` is set as a Fly runtime secret on `pagespace-web` (owner action, tracked in Phase 4), server/edge Sentry should start capturing without any code change beyond Phase 1's schema addition.
- Given `apps/web/src/app/error.tsx` (the route-segment boundary, hit far more often than `global-error.tsx`) currently only `console.error`s, it should also call `Sentry.captureException(error)`, matching the pattern already present in `global-error.tsx:14`.
- Given `apps/web/src/components/layout/LayoutErrorBoundary.tsx`'s `componentDidCatch` (backs the "Report Bug" flow) currently only `console.error`/`console.warn`s, it should also call `Sentry.captureException`.

---

## Phase 3 — apps/admin Sentry (Next.js — mirror web)

Admin already has `src/instrumentation.ts` (ClickHouse probe + shared logger composition root) but zero Sentry wiring.

**Requirements**:
- Given `apps/admin/package.json`, `@sentry/nextjs` (matching web's `^10.56.0`) should be added.
- Given new `apps/admin/sentry.server.config.ts`, `sentry.edge.config.ts`, `instrumentation-client.ts` mirroring web's shape and importing the Phase-1 shared `getSentryOptions()`, and `apps/admin/src/instrumentation.ts` updated to import them per-runtime and export `onRequestError = Sentry.captureRequestError`, admin should reach production parity with web's Sentry wiring.
- Given `apps/admin/src/instrumentation.ts`, it should call the Phase-1 `requireSentryDsn('admin')`.
- Given `apps/admin/next.config.ts` currently has no Sentry wrapping, it should be wrapped with `withSentryConfig` using admin's own `SENTRY_PROJECT`/DSN (separate Sentry project recommended for a clean issue stream, distinct from web).

---

## Phase 4 — apps/realtime Sentry (plain Node http + Socket.IO)

Realtime has zero global crash handlers today (confirmed: no `process.on('uncaughtException'|...)` anywhere), despite already importing the shared `loggers` that make wiring this trivial.

**Requirements**:
- Given `apps/realtime/package.json`, `@sentry/node` should be added (same major version as `@sentry/nextjs`).
- Given a new `apps/realtime/src/instrument.ts` calling `Sentry.init(getSentryOptions({...}))` and `requireSentryDsn('realtime')`, it should be imported as the **first** import statement in `src/index.ts` (required for Sentry Node's auto-instrumentation to see subsequently-imported modules).
- Given `initializeLogging`/`setupErrorHandlers` is called near the top of `src/index.ts` with a hook of `(err) => { Sentry.captureException(err); return Sentry.flush(2000); }`, realtime should gain its first-ever global crash visibility (today an uncaught exception just kills the process with no record anywhere).
- Scope is SDK init + global process handlers only — do not retrofit every existing `try/catch` → `loggers.realtime.error(...)` call site to also call `Sentry.captureException`; that's a larger follow-up, not this epic.

---

## Phase 5 — apps/processor Sentry (Express)

**Requirements**:
- Given `apps/processor/package.json`, `@sentry/node` should be added.
- Given a new `apps/processor/src/instrument.ts` (same pattern as realtime) imported as the first line of `src/server.ts`, and `requireSentryDsn('processor')` called there.
- Given `Sentry.setupExpressErrorHandler(app)` registered after all route mounts but before the existing custom error middleware (`server.ts:364-370`), Sentry should capture first while the existing JSON error response stays unchanged.
- Given processor currently has SIGTERM/SIGINT handling but no `uncaughtException`/`unhandledRejection` handlers, `setupErrorHandlers` from `packages/lib` (with the Sentry-capture-and-flush hook) should be added — independent of processor's own local logger, since `setupErrorHandlers` only needs `packages/lib`'s `loggers.system`.

---

## Phase 6 — apps/control-plane Sentry (Fastify)

**Note**: control-plane has no Fly deploy config, no Dockerfile, and isn't in the CI build matrix — it appears to run as a host-level process (systemd?) on the tenant-provisioning VM based on its hardcoded host filesystem paths. This phase adds the code wiring; secrets/deploy plumbing (Phase 4-equivalent for this app) needs confirmation from whoever owns tenant provisioning before it's actionable.

**Requirements**:
- Given `apps/control-plane/package.json`, `@sentry/node` should be added.
- Given a new `apps/control-plane/src/instrument.ts` imported as the first line of `src/index.ts`, and `requireSentryDsn('control-plane')` called there.
- Given `Sentry.setupFastifyErrorHandler(app)` added inside `createApp()` (`src/app.ts`) right after Fastify instantiation, and `setupErrorHandlers` (with the Sentry hook) added — control-plane currently has zero `process.on(...)` handlers of any kind, so this is its first crash visibility of any form.

---

## Phase 7 — Deploy plumbing (CI, Dockerfiles, Fly secrets, .env.example)

### CI + Docker build-arg wiring for admin

**Requirements**:
- Given `.github/workflows/docker-images.yml`'s build-args block (currently `matrix.service == 'web'`-gated only), an `admin`-gated block should be added using new `NEXT_PUBLIC_SENTRY_DSN_ADMIN`/`SENTRY_PROJECT_ADMIN` GH secrets (reusing the existing `SENTRY_ORG`/`SENTRY_AUTH_TOKEN`), and `apps/admin/Dockerfile` should gain the matching `ARG`/`ENV` pairs mirroring `apps/web/Dockerfile:68-75`.
- Given realtime/processor/control-plane read `SENTRY_DSN` as a plain runtime var (no bundler, no source-map upload in this first pass), they need no new GH Actions build-args.

### Fly secrets + .env.example

**Requirements**:
- Given `pagespace-web`, `pagespace-admin`, `pagespace-realtime`, `pagespace-processor` each need a `SENTRY_DSN` Fly secret (owner-run `flyctl secrets set`), the fly.*.toml secrets comment blocks in `PageSpace-Deploy/fly/` should document the new requirement per app (the actual `flyctl secrets set` invocation is an owner action, not a file change).
- Given `apps/realtime` has no `.env.example` today, one should be created (matching the `apps/processor/.env.example` precedent) documenting `SENTRY_DSN`; `apps/admin/.env.example` should gain the same line.
- Given control-plane's actual deploy/secrets mechanism is unconfirmed (see Phase 6 note), skip its `.env.example` until that's resolved.

---

## Phase 8 — End-to-end verification (owner-run, no new code)

**Requirements**:
- Given every app now has the Sentry SDK present in its running container, each should be verifiable the same way: `flyctl ssh console --app <app> -C "node -e \"...Sentry.init/captureException/flush...\""` (or the equivalent for control-plane's actual host once Phase 6's deploy question is resolved) — no new debug endpoints or auth needed, and the same command is reusable any time a DSN is rotated.
- Given the new fail-loud check from Phase 1, running `NODE_ENV=production bun run --filter web start` locally without `SENTRY_DSN` set should throw from `validateEnv()` before the server starts.
