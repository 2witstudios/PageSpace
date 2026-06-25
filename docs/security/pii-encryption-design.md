# PII Encryption Design Decision (GDPR S4:F1 / #965)

**Status:** ACCEPTED — this is the Phase-0 hard gate for the GDPR Encryption epic
(`tasks/gdpr-encryption-at-rest-epic.md`). No column encryption lands until the
decisions below are settled, and **no searchable column is encrypted without a
working lookup path proven by a test.**

## Context

Today only OAuth/integration credentials are encrypted at the application layer
(`packages/lib/src/encryption/encryption-utils.ts`, AES-256-GCM with a per-value
random salt+IV, wrapped by `integrations/credentials/encrypt-credentials.ts`).
Core PII columns are plaintext. Article 32(1)(a) requires encryption of personal
data at rest where appropriate; email/name/IP and free-text content are the
exposure.

The hard problem: AES-256-GCM as used today is **randomized** — the same
plaintext encrypts to different ciphertext every time (fresh salt+IV per call).
That is exactly what we want for confidentiality, but it **destroys equality
lookups, unique constraints, and search**. `users.email` is looked up by exact
equality 27 times across the codebase (`eq(users.email, …)`) and carries a
UNIQUE constraint; `security_audit.ipAddress` is filtered through
`idx_security_audit_ip (ipAddress, timestamp)`. Encrypting those with random
AES-GCM alone would break authentication and audit queries.

## The two mechanisms

1. **Random AES-256-GCM** (existing `encrypt`/`decrypt`) — maximum
   confidentiality, **not** queryable. Use for columns we only ever read back by
   primary key / foreign key, never filter or join on by value.

2. **Deterministic blind index** — a keyed HMAC-SHA256 of the *normalized*
   plaintext stored in a sibling column (e.g. `emailBidx`). Equality lookups and
   uniqueness run against the blind index; the *value* itself is still stored as
   random AES-256-GCM ciphertext in the original column. This preserves equality
   semantics and uniqueness while leaking only equality (not order, not
   substring). The HMAC key MUST be **domain-separated from the AES key** so that
   compromise of one secret does not collapse the other's guarantees.

We deliberately reject *deterministic AES* (ECB/SIV over the raw value) as the
storage form: a blind-index-plus-randomized-ciphertext split gives us equality
search without making the stored value itself deterministic, and keeps the
lookup secret separate from the at-rest secret.

## Key management

- `ENCRYPTION_KEY` (existing, ≥32 chars) remains the master secret for
  `encrypt`/`decrypt` (random AES-256-GCM at-rest ciphertext).
- The blind-index HMAC key is **derived** from the master via domain-separated
  derivation (`HKDF`/scrypt with a fixed `"pii-blind-index-v1"` info/salt label),
  NOT used directly. This means: one secret to rotate, but the index key and the
  ciphertext key are cryptographically distinct, so leaking the derived index key
  (e.g. via a query log) does not reveal the at-rest key, and vice versa.
- Rotation: changing `ENCRYPTION_KEY` requires a re-encrypt + re-index backfill
  (out of scope for this pass; the backfill job is built to be re-runnable, which
  is the rotation primitive).

## Per-column decisions

| Column | Queried how? | Decision | Lookup path |
|---|---|---|---|
| `users.email` | `eq(users.email, …)` ×27 + UNIQUE | **Blind index** `emailBidx` (UNIQUE) + random AES-GCM value | `where emailBidx = blindIndex(email)` |
| `users.name` | display only — never filtered by value | **Random AES-256-GCM** | read-back + decrypt, no index |
| `device_tokens.ipAddress` / `lastIpAddress` | stored for forensics; not filtered by value | **Random AES-256-GCM** | read-back + decrypt |
| `security_audit.ipAddress` | `idx_security_audit_ip (ipAddress, timestamp)` — equality filter | **Blind index** `ipBidx` + random AES-GCM value | `where ipBidx = blindIndex(ip)` |
| `pages.content`, `chatMessages.content` | `ilike(pages.content, '%word%')` — **substring** search | **SCOPED OUT this pass** | no equality/substring-preserving scheme exists without searchable-encryption; see below |

### Why content is scoped OUT (explicit rationale)

`apps/web/src/app/api/search/route.ts:58` runs
`ilike(pages.content, '%${word}%')` — a **substring** match. Neither random
AES-GCM nor a deterministic blind index can answer a substring query: a blind
index only preserves *exact-equality*, and substring/prefix search over
ciphertext requires a dedicated searchable-symmetric-encryption (SSE) or
tokenized-trigram index that does not exist in this codebase. Per the hard gate
("do NOT encrypt a searchable column without a working lookup path proven by a
test"), content encryption is **deferred** and tracked as a follow-up that must
ship its own search path (move FTS to an app-layer encrypted index) before any
content column is encrypted. Encrypting it now would silently break search.

### Email normalization

`emailBidx = HMAC(indexKey, lower(trim(email)))`. Email is normalized
(lowercase + trim) before hashing so equality matches the case-insensitive
intent of the existing unique constraint and login flow. The displayed/stored
ciphertext preserves the original casing.

## Rollout safety

- Field helpers (`encryptField`/`decryptField`) detect legacy plaintext (absence
  of the `salt:iv:tag:ct` 4-part shape) and pass it through unchanged, so reads
  succeed mid-backfill before every row is encrypted.
- The backfill job is idempotent (skips already-encrypted rows) and resumable.
- File-storage and processor changes (Phases 3–4) gate encryption behind config
  so cloud (already infra-disk-encrypted) is unaffected and onprem/tenant opt in.

## Implementation status (#965)

**Shipped + unit-tested (additive, no behavior change yet):**
- Pure crypto core: `blind-index.ts` (domain-separated HMAC), `field-crypto.ts`
  (rollout-safe `encryptField`/`decryptField`, IPv6-safe ciphertext detection).
- User edge: `user-crypto.ts` (`encryptUserPii` / `decryptUserPii` /
  `emailLookupBidx` / `getPiiIndexKey`) — proves the email blind-index lookup
  path by test.
- Schema migration `0171`: `users.emailBidx` (+ unique index),
  `security_audit_log.ip_bidx` (+ index, forward-only).
- Idempotent, resumable, dry-run backfill: `scripts/backfill-user-pii-encryption.ts`
  + pure planner `user-pii-backfill.ts`.

**Remaining: live call-site cutover (gated rollout, NOT done in the worktree).**
Encryption is not yet "on": the app still writes plaintext and looks up by raw
`email`. Flipping the ~27 `eq(users.email, …)` read sites + user create/update
writes to the encryption edge changes the passwordless-auth hot path, which
cannot be safely validated by the unit-only test environment available here
(integration/React tests do not run in a `.pu` worktree). The cutover is a
deliberate, separately-tested step and MUST follow this safe order:

1. Deploy migration `0171` (additive, nullable — safe).
2. Deploy app writing `email` ciphertext + `emailBidx` on create/update while
   reads use a **dual lookup**: blind index first, fall back to raw-email match.
   `decryptField` tolerates both encrypted and legacy plaintext, so mixed state
   is safe.
3. Run the backfill (dry-run, then live) with `ENCRYPTION_KEY` set.
4. After 100% backfilled + verified, retire the raw-email fallback and drop the
   raw `email` unique constraint in favor of `users_email_bidx_idx`.

Each step is reversible and never leaves auth in a broken state. Until step 2
ships, the columns added here are inert.

## Out of scope for this design (tracked elsewhere in the epic)

- File storage at rest envelope encryption — #966, Phase 3.
- Processor extracted-text retention — #973, Phase 4.
- Encryption in transit (HSTS/internal/cert-pinning) — #969, Phase 5.
- Encrypted pg_dump backups — #956, Phase 6.
- Content-column encryption + encrypted search index — **follow-up**, blocked on
  a proven encrypted-search path.
