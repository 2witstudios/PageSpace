# GDPR Encryption (at rest + in transit) Epic

**Status**: 🚧 IN REVIEW — PageSpace PR #1715, PageSpace-Deploy PR #10
**Goal**: Close the encryption-at-rest and in-transit GDPR findings (#965, #966, #973, #956, #969, #971) so PageSpace passes enterprise/EU vendor security reviews.

**Progress:** #971 ✅ #973 ✅ done · #966 ◐ #969 ◐ #956 ◐ #965 ◐ foundation shipped,
gated follow-ups documented (file decrypt-proxy delivery, internal-traffic/cert-
pinning, live auth call-site cutover). ~90 unit tests, all TDD RED→GREEN.

## Overview

Because plaintext-at-rest cost grows every day data accumulates, PageSpace must encrypt core PII and content before more plaintext piles up: today only OAuth/integration credentials are encrypted (`packages/lib/src/encryption/encryption-utils.ts`, AES-256-GCM). This epic adds application-layer encryption for queried PII (email, security-audit IP) via deterministic blind indexes that preserve equality lookups, random AES-256-GCM for non-queried PII (name, device IPs), envelope encryption for file storage at rest, ephemeral-only handling of extracted document text in the processor, encrypted database backups, and hardened encryption-in-transit (HSTS, internal-traffic posture, cert-pinning guidance) — every change driven by a failing test first with all crypto logic in pure, deterministic functions.

---

## Phase 0 — Design Gate (BLOCKS all encryption work)

### Author PII encryption design-decision doc

Write `docs/security/pii-encryption-design.md` deciding, per target column, deterministic-blind-index vs random AES-256-GCM, grounded in actual query usage.

**Requirements**:
- Given a column queried by exact equality (`users.email` — `eq(users.email, …)` + unique constraint; `security_audit.ipAddress` — `idx_security_audit_ip`), should specify a deterministic HMAC-SHA256 blind-index column plus random AES-256-GCM storage, never random encryption alone.
- Given a non-queried PII column (`users.name`, `device_tokens.ipAddress`/`lastIpAddress`), should specify random AES-256-GCM with no blind index.
- Given a full-text-searched content column, should prove no working app-layer lookup path exists yet and therefore scope it OUT of this pass with explicit rationale (no encrypting a searchable column without a proven lookup path).
- Given the existing `ENCRYPTION_KEY`, should require a SEPARATE derived index key for blind indexes so ciphertext-key compromise does not also break index unlinkability.

---

## Phase 1 — Pure crypto core (#965 foundation)

### Blind-index pure function

Add `packages/lib/src/encryption/blind-index.ts` — a pure deterministic HMAC function for equality-searchable fields.

**Requirements**:
- Given the same normalized input twice, should produce identical hex digests (deterministic) so equality lookups work.
- Given two inputs differing only in case/whitespace for email, should normalize (lowercase + trim) before hashing so `Foo@bar.com ` and `foo@bar.com` collide.
- Given a missing or short index key, should throw rather than silently hashing with a weak/empty key.
- Given the ciphertext encryption key as the only secret, should derive a DISTINCT index key (domain-separated) so the blind-index secret ≠ the AES key.

### Reversible field-encryption helpers

Add pure `encryptField`/`decryptField` wrappers (over existing `encrypt`/`decrypt`) that tolerate already-plaintext legacy values during rollout.

**Requirements**:
- Given a value encrypted by `encryptField`, should round-trip back to the exact original via `decryptField`.
- Given a legacy plaintext value (no `salt:iv:tag:ct` shape), should detect it and return it unchanged rather than throwing, so reads work mid-backfill.
- Given an empty/null field value, should pass it through unchanged (do not encrypt empty strings).

---

## Phase 2 — Column encryption + backfill (#965)

### Schema: add blind-index + widen encrypted PII columns

Edit `packages/db/src/schema/auth.ts` + `security-audit.ts`; run `bun run db:generate`.

**Requirements**:
- Given email must stay unique and lookup-able, should add an `emailBidx` column with a unique index and drop reliance on the raw `email` unique constraint for lookups.
- Given `security_audit.ipAddress` is range/equality queried, should add an `ipBidx` column preserving the existing IP-filter query path.
- Given migrations must not be hand-written, should generate via `bun run db:generate` and resolve any numbering collision with master by regenerating.

### Encryption-aware user repository edge

Thin imperative layer that writes `email` ciphertext + `emailBidx`, and resolves lookups via the blind index.

**Requirements**:
- Given a user is created/updated, should persist AES-GCM email ciphertext AND the deterministic `emailBidx`, never plaintext email.
- Given a login/lookup by email, should resolve via `emailBidx = blindIndex(email)` and return the same row that the old `eq(users.email, …)` returned (lookup path proven by test).
- Given a row read back, should decrypt `email`/`name` to plaintext at the edge so callers are unaffected.

### Backfill migration job

Idempotent job encrypting existing plaintext email/name/IP rows and populating blind-index columns.

**Requirements**:
- Given a row already encrypted (re-run), should skip it (idempotent) and not double-encrypt.
- Given a plaintext row, should populate ciphertext + blind index in a single pass and be resumable after interruption.
- Given a dry-run flag, should report counts without writing.

---

## Phase 3 — File storage at rest (#966)

### Envelope-encryption pure codec

Add a pure stream/buffer codec that wraps stored bytes with AES-256-GCM under a per-object data key.

**Requirements**:
- Given a buffer encrypted then decrypted, should return byte-identical plaintext.
- Given a tampered ciphertext/auth tag, should fail closed (throw) rather than return corrupt bytes.
- Given encryption is disabled by config, should pass bytes through so cloud (infra-encrypted) deployments are unaffected and onprem/tenant can opt in.

### Wire envelope codec into ContentStore

Apply the codec at `apps/processor/src/cache/content-store.ts` PUT/GET edges for originals and cache objects.

**Requirements**:
- Given a saved original/cache object, should store ciphertext in S3 and transparently decrypt on read so `getOriginal`/`getCache` callers are unchanged.
- Given an object stored before encryption was enabled (legacy plaintext), should still read correctly.

---

## Phase 4 — Processor ephemeral text (#973)

### Stop persisting extracted text; ephemeral handling

Edit `apps/processor/src/workers/text-extractor.ts` so extracted document text is not retained unencrypted/indefinitely.

**Requirements**:
- Given extraction succeeds, should return text to the caller without writing an indefinitely-retained plaintext `extracted-text.txt` cache object (or write it only encrypted with a TTL).
- Given any temp file is written during extraction, should delete it in a `finally` so failures don't leak plaintext on disk.
- Given the cached-text path is still required by downstream search, should route it through the Phase 3 envelope codec rather than plaintext.

---

## Phase 5 — Encryption in transit (#969)

### Unconditional HSTS + transit posture

Edit `apps/web/src/middleware/security-headers.ts` and document internal-traffic + mobile cert-pinning posture.

**Requirements**:
- Given any HTTPS response, should emit HSTS regardless of `isProduction` (gated instead on request scheme/host so localhost http dev is unaffected) so prod-like envs are not silently unprotected.
- Given the error-response helper, should apply the same HSTS rule as the main helper (no divergence).
- Given internal service-to-service traffic and mobile clients, should document the TLS/cert-pinning requirement in `docs/security/encryption-in-transit.md` with a test asserting the header policy.

---

## Phase 6 — Backups + search-test hardening (#956, #971)

### Encrypted pg_dump backups

Add an encrypted-backup wrapper (pure arg/command builder + script) for the deploy repo's pg_dump path.

**Requirements**:
- Given a backup is produced, should encrypt it at rest (age/gpg/openssl AES-256) with the key sourced from env, never written plaintext to disk.
- Given the command builder, should be a pure function returning the exact argv so it is unit-testable without running pg_dump.

### Runtime search-index PII enforcement

Replace the static-only check in `apps/web/src/app/api/search/__tests__/gdpr-audit-compliance.test.ts` with a runtime assertion path.

**Requirements**:
- Given an audit-detail builder is called with a user query string, should prove at runtime (pure function under test) that the query text never enters the audited `details` payload.
- Given the static source check, should keep it as a regression guard but no longer be the only enforcement.
