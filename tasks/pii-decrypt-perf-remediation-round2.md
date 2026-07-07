# PII Decrypt Perf Remediation — Round 2 Epic

**Status**: 📋 PLANNED
**Goal**: Finish closing the PII-decrypt latency regression that PR #1930/#1931 only partially fixed — every existing user's PII is still on the slow path, and several hot routes were never wired into the dedup fix.

## Overview

Because PR #1930's expand-contract fix only speeds up brand-new writes and only deduped 3 of the routes that decrypt PII in a per-row loop, production response times are still elevated hours after both perf PRs deployed: the one-time backfill (`scripts/backfill-user-pii-encryption.ts`) that encrypted all 224 existing users ran on 2026-07-06, a full day before #1930 introduced the fast ciphertext format, so every existing user's `email`/`name` is permanently stuck on the slow unmemoized-scrypt-per-record legacy decrypt path (`deriveLegacyKey`) until re-encrypted — and grep found `inbox`, `messages/conversations`, `messages/conversations/[conversationId]`, `messages/threads`, `connections`, and `connections/search` routes still doing undeduped per-row `decryptField` calls that PR #1930 never touched. This epic closes both gaps with zero behavior change, full backwards compatibility with mixed-format data mid-migration, and pure-function-core/imperative-shell TDD throughout, following the exact patterns already established in `encryption-utils.ts` (`parseEnvelope`/`buildEnvelope`/`encryptWithKey`/`decryptWithKey`) and `blind-index.ts` (`memoizeSyncByKey`).

---

## Legacy-ciphertext re-encryption backfill

**Status**: ✅ DONE (PR #1936 — live production run is a separate, explicit,
human-supervised step; every reader of `users.email`/`users.name` must be on a
#1930-aware image first, gated by `--apply` +
`LEGACY_CIPHERTEXT_REENCRYPT_CONFIRMED=true`)

Idempotent, resumable, dry-run-by-default script that reads every legacy-4-part-format `users.email`/`name` row, decrypts it via the existing dual-format `decrypt()`, and re-encrypts it via `encrypt()` (which always emits the fast 3-part format) — converging every row to the fast format so the legacy scrypt path is no longer on the hot read path for any existing user.

**Requirements**:
- Given a row already in fast-format ciphertext, should skip it (idempotent re-runs converge to zero work, mirroring `scripts/backfill-user-pii-encryption.ts`'s existing-row skip).
- Given a row in legacy-format ciphertext, should decrypt then re-encrypt it to fast format in a single pass, byte-identical plaintext round-trip proven by test.
- Given the migration is interrupted mid-run, should be resumable (cursor-based batching, same pattern as the existing backfill) without re-processing already-converted rows or losing progress.
- Given a dry-run flag (default), should report counts (legacy found / would-convert) without writing, requiring the same explicit `--apply` + confirmed-cutover-deployed gate pattern as the existing backfill before any live write.
- Given the planner logic (which rows need conversion, what the new value should be), should be a pure function separate from the DB I/O shell, unit-tested without a real database — same split as `planUserPiiBackfill`.

---

## Dedup PII decrypts in inbox route

Wire the existing `decryptUsersByIdOnce` helper (`packages/lib/src/auth/user-repository.ts`, added by PR #1930) into `apps/web/src/app/api/inbox/route.ts`'s three per-row `decryptField` call sites so a repeated sender/participant within one request's result set decrypts once, not once per row.

**Requirements**:
- Given an inbox response listing multiple conversations from the same sender, should decrypt that sender's name exactly once for the whole request (call-count assertion via the same test pattern PR #1930 used against `decryptUsersByIdOnce`, not a dist-boundary mock on the inner `decryptField`).
- Given the route's existing response shape and decrypted values, should be byte-identical to before the change (behavior-preserving refactor, not a new feature).

---

## Dedup PII decrypts in messages routes

Apply the same `decryptUsersByIdOnce` wiring to `apps/web/src/app/api/messages/conversations/route.ts`, `apps/web/src/app/api/messages/conversations/[conversationId]/route.ts`, and `apps/web/src/app/api/messages/threads/route.ts`.

**Requirements**:
- Given a conversations/threads list with repeated other-party users across rows, should decrypt each unique user once per request.
- Given the single-conversation detail route, should still correctly decrypt when only one distinct user is present (no regression for the common case).

---

## Dedup PII decrypts in connections routes

Apply the same `decryptUsersByIdOnce` wiring to `apps/web/src/app/api/connections/route.ts` and `apps/web/src/app/api/connections/search/route.ts`.

**Requirements**:
- Given a connections list or search result with repeated users, should decrypt each unique user once per request.
- Given the search route's existing filtering/ranking behavior, should be unaffected by the decrypt-path change.

---

## Verify recovery

After all four tasks land and deploy, confirm the fix actually closes the gap rather than just asserting it should.

**Requirements**:
- Given the full lib + web test suites and `bun run typecheck`, should be green with zero new failures across all four preceding tasks.
- Given the fix is deployed to `pagespace-web`, should show HTTP Response Time Avg back down near the pre-regression ~0.3-0.5s baseline on the same Grafana panel used to diagnose this, not just an assumption that the code change helped.

---

## Follow-ups surfaced by PR #1936 review (not yet scheduled)

- Other columns also hold pre-#1930 legacy 4-part ciphertext and pay
  scrypt-per-decrypt on every read: integration connection credentials
  (decrypted per tool execution), Google/Zoom OAuth tokens (token refresh only
  rewrites the access token, so refresh tokens stay legacy indefinitely), and
  `security_audit_log.ipAddress` rows written 2026-06-25 → 2026-07-06. Each
  needs its own backfill reusing `reencryptLegacyValue` from
  `packages/lib/src/encryption/legacy-ciphertext-reencrypt.ts`.
- Systemic mitigation to consider: a small LRU keyed by salt in
  `deriveLegacyKey` (mirroring the masterKeyCache pattern) would collapse
  repeated decrypts of the same legacy value to one scrypt process-wide,
  covering all legacy surfaces including the window before each backfill runs.
