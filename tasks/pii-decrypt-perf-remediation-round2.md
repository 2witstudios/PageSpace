# PII Decrypt Perf Remediation — Round 2 Epic

**Status**: 📋 PLANNED
**Goal**: Finish closing the PII-decrypt latency regression that PR #1930/#1931 only partially fixed — every existing user's PII is still on the slow path, and several hot routes were never wired into the dedup fix.

## Overview

Because PR #1930's expand-contract fix only speeds up brand-new writes and only deduped 3 of the routes that decrypt PII in a per-row loop, production response times are still elevated hours after both perf PRs deployed: the one-time backfill (`scripts/backfill-user-pii-encryption.ts`) that encrypted all 224 existing users ran on 2026-07-06, a full day before #1930 introduced the fast ciphertext format, so every existing user's `email`/`name` is permanently stuck on the slow unmemoized-scrypt-per-record legacy decrypt path (`deriveLegacyKey`) until re-encrypted — and grep found `inbox`, `messages/conversations`, `messages/conversations/[conversationId]`, `messages/threads`, `connections`, and `connections/search` routes still doing undeduped per-row `decryptField` calls that PR #1930 never touched. This epic closes both gaps with zero behavior change, full backwards compatibility with mixed-format data mid-migration, and pure-function-core/imperative-shell TDD throughout, following the exact patterns already established in `encryption-utils.ts` (`parseEnvelope`/`buildEnvelope`/`encryptWithKey`/`decryptWithKey`) and `blind-index.ts` (`memoizeSyncByKey`).

---

## Legacy-ciphertext re-encryption backfill

Idempotent, resumable, dry-run-by-default script that reads every legacy-4-part-format `users.email`/`name` row, decrypts it via the existing dual-format `decrypt()`, and re-encrypts it via `encrypt()` (which always emits the fast 3-part format) — converging every row to the fast format so the legacy scrypt path is no longer on the hot read path for any existing user.

**Requirements**:
- Given a row already in fast-format ciphertext, should skip it (idempotent re-runs converge to zero work, mirroring `scripts/backfill-user-pii-encryption.ts`'s existing-row skip).
- Given a row in legacy-format ciphertext, should decrypt then re-encrypt it to fast format in a single pass, byte-identical plaintext round-trip proven by test.
- Given the migration is interrupted mid-run, should be resumable (cursor-based batching, same pattern as the existing backfill) without re-processing already-converted rows or losing progress.
- Given a dry-run flag (default), should report counts (legacy found / would-convert) without writing, requiring the same explicit `--apply` + confirmed-cutover-deployed gate pattern as the existing backfill before any live write.
- Given the planner logic (which rows need conversion, what the new value should be), should be a pure function separate from the DB I/O shell, unit-tested without a real database — same split as `planUserPiiBackfill`.

---

## Dedup PII decrypts in inbox route

**Status**: ✅ DONE

Wire the existing `decryptUsersByIdOnce` helper (`packages/lib/src/auth/user-repository.ts`, added by PR #1930) into `apps/web/src/app/api/inbox/route.ts`'s three per-row `decryptField` call sites so a repeated sender/participant within one request's result set decrypts once, not once per row.

**Requirements**:
- Given an inbox response listing multiple conversations from the same sender, should decrypt that sender's name exactly once for the whole request (call-count assertion via the same test pattern PR #1930 used against `decryptUsersByIdOnce`, not a dist-boundary mock on the inner `decryptField`).
- Given the route's existing response shape and decrypted values, should be byte-identical to before the change (behavior-preserving refactor, not a new feature).

---

## Dedup PII decrypts in messages routes

**Status**: ✅ DONE

Apply the same `decryptUsersByIdOnce` wiring to `apps/web/src/app/api/messages/conversations/route.ts`, `apps/web/src/app/api/messages/conversations/[conversationId]/route.ts`, and `apps/web/src/app/api/messages/threads/route.ts`.

**Requirements**:
- Given a conversations/threads list with repeated other-party users across rows, should decrypt each unique user once per request.
- Given the single-conversation detail route, should still correctly decrypt when only one distinct user is present (no regression for the common case).

---

## Dedup PII decrypts in connections routes

**Status**: ✅ DONE

Apply the same `decryptUsersByIdOnce` wiring to `apps/web/src/app/api/connections/route.ts` and `apps/web/src/app/api/connections/search/route.ts`.

**Requirements**:
- Given a connections list or search result with repeated users, should decrypt each unique user once per request.
- Given the search route's existing filtering/ranking behavior, should be unaffected by the decrypt-path change.

---

## Review follow-ups (round 2)

**Status**: ✅ DONE

The dedup PR's multi-agent self-review surfaced four verified follow-ups; all landed on the same branch:

- `decryptFieldValuesOnce` promoted to `packages/lib/src/encryption/field-crypto.ts` as the first-class value-keyed batch-decrypt helper (fail-closed lookup: a value missing from the batch returns `null`, never raw ciphertext). Inbox rewired onto it; the pulse `generate` + `cron` routes (same id-less per-row decrypt shape, 5 sections each) wired too.
- `/api/connections/search` derives `isSelf` from `targetRow?.id === user.id` — drops one query + one decrypt per search and **closes a case-variant self-search enumeration corner** (was: keyed case-variant self-search returned the caller's own profile as actionable; now `{user:null}`). The one intentional behavior change in the PR.
- Inbox decrypts only pagination survivors: permission-filter → sort → slice → one batched decrypt (rows the page limit discards are never decrypted).
- Type honesty + fail-closed: LEFT-JOINed user columns in `apps/web/src/types/messaging.ts` are `| null`; the messages routes' `?? raw` fallbacks are now `?? null` so no future drift can emit ciphertext.

---

## Verify recovery

After all four tasks land and deploy, confirm the fix actually closes the gap rather than just asserting it should.

**Requirements**:
- Given the full lib + web test suites and `bun run typecheck`, should be green with zero new failures across all four preceding tasks.
- Given the fix is deployed to `pagespace-web`, should show HTTP Response Time Avg back down near the pre-regression ~0.3-0.5s baseline on the same Grafana panel used to diagnose this, not just an assumption that the code change helped.
