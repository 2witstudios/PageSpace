# Task: Distributed Rate Limit — Post-Review Follow-ups

Scope: review findings on `pu/redis-pr3-ratelimit` (commit 3135dc1c). Four fixes bundled to clear the follow-up list before merge.

Status: **done**. All requirements landed in commits `45db4c05` (M1–M4) and `4ea6f140` (Codex P1: weighted sliding window).

## Requirements

### R1 — `getDistributedRateLimitStatus` must match `check` on progressive delay ✅

- **Given** a bucket with `count > maxAttempts` and a config with `progressiveDelay: true`,
  **should** return `retryAfter` computed with the same progressive formula as `checkDistributedRateLimit` — not a flat `windowMs`.

### R2 — Progressive `retryAfter` must not lie about the bucket reset ✅

- **Given** a fixed-window Postgres bucket whose progressive block would exceed the time left in the current window,
  **should** clamp the returned `retryAfter` to the remaining time in the bucket. The bucket resets at `windowStart + windowMs`; telling the client to wait longer is a false promise the server cannot keep.

### R3 — `sweep-expired` must not materialize every deleted key ✅

- **Given** the cron sweep deletes expired `rate_limit_buckets` rows,
  **should** count deletions via `rowCount` instead of `.returning({ key })`. Sweeps on high-traffic deployments can span millions of rows; we must not allocate a JS array for every one.

### R4 — `sweep-expired` route must be tested ✅

- **Given** a new cron route at `apps/web/src/app/api/cron/sweep-expired/route.ts`,
  **should** have `__tests__/route.test.ts` covering:
  - auth rejection short-circuits before any DB call or audit
  - happy path returns `{success: true, results: {rate_limit_buckets: N}}` and emits one `data.delete` audit event
  - partial failure returns 500, records the error in `results`, and still emits the audit event (matches existing route behavior)

### R5 — Prevent boundary bursting (added after Codex P1 review) ✅

- **Given** an attacker who fills the current bucket to `maxAttempts` and then crosses the bucket boundary,
  **should** continue blocking while the previous bucket's weighted contribution keeps the effective count at or above `maxAttempts`. Implemented via weighted sliding window (Cloudflare/nginx approximation); previous bucket contributes with weight `1 - msIntoBucket / windowMs`.

## Out of scope

- Removing Redis infrastructure (`services/shared-redis.ts`, `services/rate-limit-cache.ts`, `security/security-redis.ts`) — ships in PR 5 of the epic.
- Adding a `blocked_until` column to persist progressive blocks across window boundaries — would restore Redis-like semantics but is a schema change and a separate design decision.
