# PII Decrypt Perf Remediation — Round 2

## Context

The GDPR PII encryption-at-rest rollout completed 2026-07-06 and `pagespace-web`
(single 1-vCPU Fly machine) has run elevated HTTP response times since
(0.3-0.5s baseline → sustained 1-15s, one 37s spike). PR #1930 (c6e60f97f)
memoized the AES master-key scrypt derivation and PR #1931 (da3514c7f) did the
same for the blind-index HMAC key, but response times stayed elevated because:

- The one-time backfill (`scripts/backfill-user-pii-encryption.ts`) ran on
  2026-07-06 — a full day BEFORE #1930 introduced the fast 3-part
  `iv:authTag:ciphertext` envelope. All 224 existing users' `email`/`name`
  ciphertext is stuck on the legacy 4-part `salt:iv:authTag:ciphertext` format.
- `decrypt()` still runs a full unmemoized `scryptSync` per record for the
  legacy format (`deriveLegacyKey`,
  `packages/lib/src/encryption/encryption-utils.ts`), so 100% of real user PII
  reads pay the slow-scrypt cost on every request until the rows are
  re-encrypted into the fast format.

## Legacy-ciphertext re-encryption backfill — Done (this PR)

Convert every legacy-4-part-format `users.email`/`users.name` ciphertext row to
the fast 3-part format so no existing user's PII reads hit the slow legacy
scrypt path.

Deliverables:

- [x] Pure planner (`packages/lib/src/encryption/legacy-ciphertext-reencrypt.ts`)
      mirroring `planUserPiiBackfill`: per row, decide legacy (convert) vs
      fast/plaintext (skip); compute new ciphertext for legacy rows. No DB
      access or I/O — unit-testable without a database.
- [x] Runner script (`scripts/backfill-legacy-ciphertext-reencrypt.ts`)
      mirroring `backfill-user-pii-encryption.ts`: cursor-on-id-ascending
      batches, dry-run by default, live write requires `--apply` AND
      `LEGACY_CIPHERTEXT_REENCRYPT_CONFIRMED=true`, reports legacy found /
      converted / skipped / errors, resumable.

Acceptance criteria:

- [x] Fast-format row → skipped (idempotent re-runs converge to zero work).
- [x] Legacy-format row → decrypt + re-encrypt to fast format in one pass;
      byte-identical plaintext round-trip proven by test (decrypt(new) ===
      decrypt(old) === original plaintext; new envelope has 3 colon-separated
      parts, not 4).
- [x] Interrupted mid-run → resumable without re-processing converted rows.
- [x] Dry-run by default; live write gated on `--apply` + confirmation env var.
- [x] Planner is a pure function separate from the DB I/O shell, unit-tested
      without a real database.

Rollout note: the live run must only happen AFTER the fast-format-aware app
(#1930/#1931) is deployed to every reader (web, realtime, processor) — a
pre-#1930 image cannot parse the 3-part envelope. Running the backfill against
production is a separate, explicit, human-supervised step.

## Dedup decrypts in routes missed by #1930 — In Progress (parallel workstream)

A second agent is wiring the request-scoped decrypt dedup into the routes PR
#1930 missed. Independent files; no coordination with the backfill workstream.

## Follow-ups surfaced by review (not yet scheduled)

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
