# GDPR Audit — Stream 4: Data Minimization, Security & Breach

| | |
|---|---|
| **Date** | 2026-04-12 |
| **Branch** | `pu/gdpr-minimization-breach` |
| **Auditor** | Stream 4 (read-only) |
| **Articles in scope** | Art 5(1)(c), 5(1)(d), 25, 32, 33, 34, 30 (touch) |
| **Method** | Source code review against current HEAD; claims from `compliance-sovereignty-analysis.md` re-verified against actual code, not relied on |

## 0. Coordination with in-flight work

A parallel agent is operating on branches `pu/audit-pii-masking` and `pu/pii-scrub-auth-logs`. As of audit time both branches are at master tip (no committed divergence yet). Their declared scope is **SecurityAuditService route coverage hardening + activity-log hash-chain PII exclusion**, anchored on these landed commits:

- `491c7354` — bulk migrate ~170 routes to functional audit pipeline (#898)
- `b96d5220` — audit passkey + magic-link routes (#896)
- `62fe6f1d` — audit auth routes via auditRequest (#895)
- `ed11d350` — exclude PII from activity log hash chain (#866)
- `facab1cc` — GDPR-safe admin audit logging (`withAdminAuth` wrapper)
- `d74f4879` — verification alerting for audit hash chain (#544)

**Excluded from this audit:**

- `packages/lib/src/audit-log/**` — formal audit-log writers and PII handling
- `packages/lib/src/monitoring/activity-logger.ts` — PII exclusion from hash inputs
- Route-level coverage by `auditRequest()` / `audit()` pipeline

**Still in scope here:** the hash-chain VERIFIER (integrity from a different angle, see §F14), and every other surface PII may leak through.

---

## 1. Executive summary

| Severity | Count | Findings |
|---|---|---|
| CRITICAL | 4 | F2, F9, F13, F15 |
| HIGH | 5 | F1, F5a, F5c, F6, F8 |
| MEDIUM | 5 | F5b, F7, F12, F14, F16 |
| OK / observation | 4 | F3, F4, F10, F11 |

**Top blockers for any GDPR certification effort:**

1. **F15 — No breach-notification pipeline.** No incident-response runbook, no code path to notify affected data subjects at scale, no alert wiring at all. Art 33's 72h clock starts at "becoming aware"; the architecture provides no awareness path.
2. **F13 — Breach detection is silent.** Activity logging is fire-and-forget; rate limiter is in-process (single-instance only); zero PagerDuty/Opsgenie/Slack-webhook/email alerting in source. A breach happens with no human notified.
3. **F9 — Processor workers retain extracted document text on disk indefinitely, unencrypted, with no cleanup.** Direct Art 5(1)(c) and Art 5(1)(e) violation, plus Art 32 at-rest gap.
4. **F2 — File storage is unencrypted local volumes.** No SSE-KMS abstraction, no application-layer encryption for stored uploads.

**Verdict per deployment mode:**

| Mode | F1 | F2 | F5a | F5b | F6 | F8 | F9 | F13 | F15 |
|---|---|---|---|---|---|---|---|---|---|
| `cloud` | HIGH | MED (provider SSE may apply) | HIGH (staging) | HIGH (multi-host) | HIGH | MED | CRIT | CRIT | CRIT |
| `onprem` | HIGH | CRIT | n/a (operator TLS) | LOW (single-host) | HIGH | MED | CRIT | HIGH | CRIT |
| `tenant` | HIGH | CRIT | HIGH | CRIT | HIGH | HIGH | CRIT | CRIT | CRIT |

No deployment mode is currently auditable for Art 32 + Art 33 + Art 34 readiness without remediation of P0 items.

---

## 2. Findings

### F1 — No application-layer encryption for general PII columns
**Articles:** Art 32(1)(a)
**Severity:** HIGH (all modes)

**Evidence:**
- `packages/lib/src/encryption/encryption-utils.ts:6,24,49` provides AES-256-GCM with scrypt KDF and per-operation salt+IV. The primitive exists and is well-formed.
- `packages/db/src/schema/auth.ts`, `packages/db/src/schema/storage.ts`, and the schemas under `packages/db/src/schema/` for users, pages, messages, files, profiles do **not** apply that primitive to general PII columns. Email, name, profile data, page content, message bodies, file metadata are stored plaintext.
- The capability is wired for "secrets" (API keys / OAuth integration tokens) per `compliance-sovereignty-analysis.md` §397-420, not general PII.

**Why this is a finding (not just a design choice):** plaintext page content is documented as deliberate (enables AES regex search; sovereignty doc §326). That is a defensible *architectural* choice but Art 32 expects a documented risk acceptance — not the absence of one. The primitive being present-but-unapplied means the cost of applying it to a few hot columns (email, name) is small.

**Mode divergence:**
- `cloud`: provider-level disk encryption may apply (depends on infra, untestable from app code).
- `onprem` / `tenant`: no automatic at-rest encryption unless the operator adds LUKS / FDE.

**Recommendation:** Apply `encrypt()` to `users.email`, `users.name`, and any profile fields used for legal contact. Document the regex-search trade-off for `pages.content` explicitly in DPIA notes rather than inferring it from architecture.

---

### F2 — File storage at rest is unencrypted local volumes
**Articles:** Art 32(1)(a), Art 25
**Severity:** CRITICAL (`onprem`/`tenant`), MEDIUM (`cloud` — depends on infra)

**Evidence:**
- `apps/processor/src/cache/content-store.ts` writes originals + derivatives to local filesystem (`getOriginal`, `getCachePath`).
- `docker-compose.yml` mounts `file_storage` as a Docker volume with no encryption-at-rest backend, no SSE-KMS, no S3 abstraction.
- No KMS or `kms_key_id` references in source.

**Cross-link:** intersects Stream 1 (file orphaning under Art 17 — sovereignty doc §167-187 already documents that files persist after DB cascade-delete; that is not re-litigated here).

**Recommendation:** Cloud: route file storage through S3 with SSE-KMS enforced via bucket policy; document the bucket configuration as a deployment requirement. On-prem: document LUKS / dm-crypt as a deployment prerequisite.

---

### F3 — Password hashing: N/A (passwordless) — CLAUDE.md is stale
**Articles:** Art 32
**Severity:** OK (with documentation drift)

**Evidence:**
- `grep bcrypt packages/lib/src` returns **zero** matches.
- Recent commits #861, dfcdf2f5, b96d5220 confirm passkeys + magic links are the only auth flows.
- `CLAUDE.md` still says "bcryptjs passwords" — stale.

**Verdict:** WebAuthn passkeys + magic-link tokens are stronger than any bcrypt cost factor. No GDPR Art 32 concern. Documentation drift recorded in Appendix A.

---

### F4 — Session and bearer token storage uses SHA-256 hashing
**Articles:** Art 32
**Severity:** OK

**Evidence:**
- `packages/lib/src/auth/opaque-tokens.ts` — `hashToken()` applies SHA-256; tokens are 32 bytes of random base64url (256 bits entropy).
- `packages/db/src/schema/sessions.ts:10` stores `tokenHash` with unique index; no plaintext column.
- `packages/db/src/schema/auth.ts:50–51, 95–96, 135–136, 158` — device tokens, MCP tokens, verification tokens, socket tokens all use `tokenHash` + `tokenPrefix` (first 12 chars for debugging only).

**Verdict:** SHA-256 with high-entropy random tokens is correct (no salted KDF needed when the input is uniformly random). All bearer-token surfaces verified hashed at rest.

---

### F5 — Encryption in transit
**Articles:** Art 32

#### F5a — HSTS gated on `isProduction` only
**Severity:** HIGH (preview / staging environments)

**Evidence:**
- `apps/web/src/middleware/security-headers.ts:127–131`:
  ```ts
  if (isProduction) {
    response.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }
  ```
- Staging / preview / non-prod environments have no HSTS at all. CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, COEP are all set unconditionally — only HSTS is conditional.
- max-age = 63072000s = 2 years, includeSubDomains + preload — **OK for production**.

**Recommendation:** Set HSTS unconditionally; if there are environments served from `localhost` with no TLS, gate on hostname rather than on `NODE_ENV`. The current shape gives staging users a downgrade-attack window that production users don't have.

#### F5b — Internal service-to-service traffic is plaintext HTTP
**Severity:** CRITICAL (multi-host or `tenant`), LOW (single-host onprem)

**Evidence:**
- `docker-compose.yml` env wiring: `PROCESSOR_URL=http://processor:3003`, Redis with `requirepass` but no TLS, web ↔ realtime via plain `ws://`.
- All inter-service URLs use HTTP/plaintext.
- This is fine over a Docker bridge on a single trusted host. It is **not** fine on any deployment that crosses a network boundary.

**Recommendation:** Document explicitly that single-host Docker bridge is the only supported topology without additional mTLS / service-mesh wrapping; or wire an mTLS terminator / sidecar pattern for split-host deployments.

#### F5c — Mobile certificate pinning not visible
**Severity:** HIGH (mobile clients)

**Evidence:**
- This worktree does not contain `apps/ios/` or `apps/android/` (Capacitor wrappers may be in a separate path or sibling repo). Searches in this tree found no Capacitor cert-pinning plugin or native pinning configuration.

**Recommendation:** Confirm whether mobile clients exist for cloud users; if so, add cert pinning (primary + backup). If mobile is not shipped to cloud users, document that fact and remove this finding.

---

### F6 — PII leakage into non-audit logs
**Articles:** Art 5(1)(c), Art 32
**Severity:** HIGH (all modes)

The structured logger at `packages/lib/src/logging/logger.ts:130–165` redacts a fixed allow-list of sensitive keys: `password, token, secret, api_key, authorization, cookie, credit_card, ssn, jwt`. The list **does not include `email`, `userId`, `name`, `ipAddress`, or content fields**. Two consequences: (a) anything logged through the structured logger that includes those keys leaks; (b) any `console.*` call bypasses redaction entirely.

#### F6a — Email service logs userId on missing-email warn
- `packages/lib/src/services/notification-email-service.ts:288`:
  ```ts
  console.warn('Cannot send email notification: user %s has no email',
    String(data.userId).replace(/[\x00-\x1f\x7f-\x9f\n\r]/g, '').slice(0, 100));
  ```
- The userId IS sanitized for control characters and capped at 100 chars (good — log-injection safe). But the userId itself is the PII being recorded, and `console.warn` bypasses the redaction layer.

#### F6b — Processor text-extractor logs original filenames
- `apps/processor/src/workers/text-extractor.ts:12`:
  `console.log(\`Extracting text from ${originalName} (${mimeType})\`);`
- `apps/processor/src/workers/text-extractor.ts:65`:
  `console.log(\`Successfully extracted ${extractedText.length} characters from ${originalName}\`);`
- `apps/processor/src/workers/text-extractor.ts:76`:
  `console.error(\`Failed to extract text from ${originalName}:\`, error);`
- Filenames frequently contain user identity (`John_Smith_2024_W2.pdf`). Logged at info + error.

#### F6c — OCR processor logs content hashes and raw error objects
- `apps/processor/src/workers/ocr-processor.ts:28,36,69,80` — raw `console.log`/`console.error` with `contentHash`. Hash itself is not PII, but error object on line 80 may carry stack traces with extracted text fragments.

#### F6d — Drive search service logs query strings on regex timeout
- `packages/lib/src/services/drive-search-service.ts` (~line 408 per exploration) — regex query timeout warn includes the user's query string. Search queries can themselves be PII (e.g., `"john@acme.com password"`).

#### F6e — Account lockout logs email and userId
- `packages/lib/src/auth/account-lockout.ts:151–156`:
  ```ts
  loggers.api.warn('Account locked due to failed login attempts', {
    userId, email, failedAttempts, lockedUntil: ...
  });
  ```
- `packages/lib/src/auth/account-lockout.ts:161–165`:
  `loggers.api.info('Failed login attempt recorded', { userId, failedAttempts, ... });`
- This goes through the structured logger, but the redaction list (above) does **not** include `email` or `userId`. The email passes through unscrubbed.

**Recommendation:**
1. Extend the structured logger redaction list to include `email`, `name`, `ipAddress` and document the policy.
2. Add a lint rule or grep-based pre-commit forbidding `console.*` outside `scripts/` and `tools/`. Force everything through the structured logger.
3. Replace `originalName` in processor logs with `contentHash` (already available) — the name is never needed for debugging the worker.
4. Remove the user query from the regex-timeout log; log query length + time to compile only.

---

### F7 — Search index PII test only static-checks `query` literal
**Articles:** Art 5(1)(c)
**Severity:** MEDIUM

**Evidence:**
- `apps/web/src/app/api/search/__tests__/gdpr-audit-compliance.test.ts:24-32`:
  ```ts
  const pattern = /auditRequest\([^;]*details:\s*\{([^}]+)\}/g;
  ```
  This is a fragile regex; it captures only the first `{...}` block of `details`. It will miss:
  - Nested objects: `details: { filters: { query } }` is captured but only matches `query` as a word, so it works *coincidentally* for the simple cases.
  - Aliased variables: `const d = { query: q }; auditRequest(req, { details: d })` is invisible.
  - `audit()` calls (the new functional pipeline from #893) — the regex matches only `auditRequest(`.
- The test only inspects four files: `search/route.ts`, `search/multi-drive/route.ts`, `mentions/search/route.ts`, `admin/audit-logs/route.ts`. Any future search route is unprotected by default.

**Positive findings on search:**
- Result authorization is enforced via `getUserAccessLevel()` and `getDriveIdsForUser()` before return — cross-tenant leakage prevented.
- Returned fields are minimization-friendly: `id, title, type, pageType, driveId, driveName, description, avatarUrl, matchLocation, relevanceScore`. No body content in result payload.
- Search queries are parameterized for SQL safety.

**Recommendation:**
1. Replace the regex with an AST check (`@typescript-eslint/parser` walking call expressions) or a runtime mock test that calls each route and asserts on the resulting audit details object.
2. Auto-discover all routes under `app/api/**/search` rather than hard-coding four files.
3. Extend the test to cover the new functional `audit()` pipeline (matched by signature, not function name).
4. Strip the user query from `drive-search-service.ts` regex timeout logs (see F6d).

---

### F8 — Realtime broadcast endpoint trusts caller for audience authorization
**Articles:** Art 5(1)(c), Art 32
**Severity:** MEDIUM (rises to HIGH if any internal caller forgets to pre-authz)

**Evidence:**
- `apps/realtime/src/index.ts:303–340`:
  ```ts
  if (req.method === 'POST' && req.url === '/api/broadcast') {
    // ... HMAC signature check via verifySignature(signatureHeader, body) ...
    const { channelId, event, payload } = JSON.parse(body);
    if (channelId && event && payload) {
      io.to(channelId).emit(event, payload);
      // ...
    }
  }
  ```
- `verifyBroadcastSignature` (line 289) checks HMAC integrity — i.e. that *the body has not been tampered with in transit and was signed by something holding the broadcast secret*. It does **not** check whether the caller is authorized to address that `channelId` or to ship that `payload` to the room's members.
- The signature is therefore an authentication-of-internal-caller, not an authorization-of-audience.

**Strong findings on the rest of realtime:**
- `apps/realtime/src/index.ts:516` — channel join calls `getUserAccessLevel(user.id, pageId)`. ✓
- `apps/realtime/src/index.ts:547` — drive join calls `getUserDriveAccess(user.id, driveId)`. ✓
- `apps/realtime/src/index.ts:757` — page presence join checks access level before broadcast. ✓
- Per-event auth wrapper `withPerEventAuth` on document-update events. ✓
- Logs are payload-key-only (`Object.keys(payload)`) — no PII in broadcast log lines (line 320–323).

**Why F8 is a finding even with HMAC:** GDPR's privacy-by-default expectation (Art 25) is that the riskier path is the locked-down one. The broadcast endpoint is the riskiest path in realtime — it can address any channel. Putting only HMAC on it means a single bug in any internal caller (a route that constructs `channelId` from user input without authz) becomes a cross-tenant leak.

**Recommendation:** Either (a) include the audience constraints in the signed payload (e.g. sign `{drive, channel, expectedRecipientCount}` and have the realtime server cross-check against its room state), or (b) add a server-side authz hook keyed on an `X-Internal-Caller` identity header so the realtime service can independently verify the broadcast is allowed.

---

### F9 — Processor workers retain extracted document text indefinitely on disk, unencrypted
**Articles:** Art 5(1)(c) minimization, Art 5(1)(e) storage limitation, Art 17 erasure
**Severity:** CRITICAL (all modes)

#### F9a — `text-extractor.ts` writes full extracted text to fs cache
- `apps/processor/src/workers/text-extractor.ts:58–63`:
  ```ts
  const cacheDir = path.dirname(await contentStore.getCachePath(contentHash, 'text'));
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(
    path.join(cacheDir, 'extracted-text.txt'),
    extractedText
  );
  ```
- Full plaintext document content is persisted to disk. There is no TTL, no cleanup, no expiry job, no encryption.

#### F9b — `ocr-processor.ts` writes OCR text to fs cache
- `apps/processor/src/workers/ocr-processor.ts:65–67`:
  ```ts
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(ocrCachePath, ocrText);
  ```
- Same pattern: extracted text persisted plaintext, indefinitely. (The cache is intentional — line 35 reads it back on subsequent jobs — so deletion needs a coordinated retention policy, not a naïve unlink.)

#### F9c — `content-store.ts` retains `originalName` and uploads association indefinitely
- The content store keeps `originalName`, `size`, `mimeType`, `contentHash` in metadata, plus a `uploads[]` array of `(userId, driveId)` tuples mapping every user that uploaded a file with the same content hash. No deletion methods. Cross-link to sovereignty doc §167-187 (file orphaning).

#### F9d — Cache is not segmented by tenant
- Cache paths are content-hash-keyed, not tenant-keyed. Two tenants uploading the same file share the same cache entry. For deduplication that's fine; for tenant erasure under Art 17 it means "delete tenant X's data" cannot delete the cache entry without breaking tenant Y.

**Recommendation:**
1. Implement a cache TTL (e.g. 30 days since last `getCachePath` access) and a periodic cleanup worker.
2. Encrypt the cache files with a per-content-hash key derived from the master key, or use a filesystem-encrypted mount.
3. For Art 17 erasure: maintain a tenant-uploads index and on tenant deletion remove only that tenant's `(userId, driveId)` tuple from `uploads[]`; once the array is empty, delete the cache files and originals.
4. Stop logging `originalName` in worker logs (see F6b).

---

### F10 — AI chat retention and analytics
**Articles:** Art 5(1)(e), Art 32
**Severity:** OK (with cross-stream handoff)

**Evidence:**
- `packages/db/src/schema/chat.ts` — chat messages stored with `userId`, `content`, `pageId`, `role`, `messageType`, `attachmentMeta`, `aiMeta`. By design — required for conversation history.
- `apps/web/src/lib/ai/core/conversation-state.ts` — cookie-based state stores `conversationId` only, not content.
- **Verified: no analytics dependencies in any package.json.** `grep '@sentry|posthog|datadog|bugsnag|rollbar|newrelic|@opentelemetry' apps/*/package.json packages/*/package.json` returns zero matches. AI prompts are NOT forwarded to analytics, telemetry, or observability vendors.
- LLM provider calls (Anthropic, OpenAI, etc) **are** transfers to third parties — that is Stream 3's surface (cross-border transfers + processors). Cross-link, no finding here.

**Open question:** there is no documented TTL on `chat.content` for active accounts. Sovereignty doc §139-165 noted this for `aiUsageLogs`; verify whether chat tables have the same gap. (Recommend Stream 1 cover this under Art 5(1)(e).)

---

### F11 — Error reporting pipeline absent
**Articles:** Art 32
**Severity:** OK (with operational caveat)

**Evidence:**
- No external error-reporting service configured (verified by package.json grep above).
- The structured logger (`packages/lib/src/logging/logger.ts:130–165`) has redaction-on-by-default, with the limited allow-list called out in F6.

**Operational caveat:** the absence of automated error reporting means production debugging relies on operators reading logs directly. The risk is operators copy-pasting plaintext log lines (which currently contain emails per F6e and filenames per F6b) into chat / tickets. The fix is fixing F6, not adding error reporting.

---

### F12 — Secret handling
**Articles:** Art 32

**`.env` files: NONE COMMITTED** (OK)
- `.env.example`, `.env.onprem.example`, `.env.test.example` are templates. `.env*` proper is in `.gitignore`. Verified.

**Secret scanning in CI: ENABLED** (OK)
- `.github/workflows/security.yml:219–236` runs TruffleHog v3.94.2 on every push/PR with `fetch-depth: 0` and `--only-verified`.

**Hardcoded keys:** sampled grep for `sk-`, `AKIA`, `ghp_` in source returned no matches.

**Secret rotation:** MEDIUM
- No rotation logic for long-lived MCP tokens, device tokens, or stored OAuth integration secrets. Rely on expiry + manual revoke.
- Recommend a scheduled "tokens older than N days" report visible to admins, and an admin "rotate now" affordance for MCP tokens.

---

### F13 — Monitoring, anomaly detection, and alerting
**Articles:** Art 32, Art 33 (Art 33's 72h clock starts at "becoming aware")
**Severity:** CRITICAL (cloud, tenant), HIGH (onprem)

#### F13a — Rate limiter is in-process Map, single-instance only
- `packages/lib/src/auth/rate-limit-utils.ts:1–18`:
  ```ts
  // Simple in-memory rate limiter for local deployment
  // For production with multiple instances, consider Redis-based rate limiting
  // ...
  const attempts = new Map<string, RateLimitAttempt>();
  ```
- The codebase **knows about the gap** — the comment is from the original author. In any cloud / tenant deployment with >1 web instance, the limiter is bypassed by horizontal load distribution.
- A second instance of the same in-process pattern lives in `apps/processor/src/workers/ocr-processor.ts:8` for external OCR API rate limiting.
- Configured limits: LOGIN 5/15min → 15min block; SIGNUP 3/1hr; PASSWORD_RESET 3/1hr; REFRESH 10/5min. Reasonable values; ineffective enforcement.

#### F13b — Account lockout fires no security event
- `packages/lib/src/auth/account-lockout.ts:151–156` — when an account locks due to failed logins, the only signal emitted is `loggers.api.warn(...)`. No SIEM event, no security-audit log entry, no alert.
- Log noise is not detection.

#### F13c — Zero anomaly detection
- No detection for: credential stuffing, mass export, mass delete, impossible-travel logins, privilege escalation, abnormal AI usage volume, abnormal file download volume.
- Activity logging (`packages/lib/src/monitoring/activity-logger.ts`) is fire-and-forget async writes to `activityLogs` — pure forensic capture, no real-time inspection or threshold rules.

#### F13d — Zero alerting wiring
- `grep -i 'pagerduty|opsgenie|slack.*webhook|SLACK_WEBHOOK|alertmanager'` across the repository returns matches **only** in:
  - `prototypes/pagespace-endgame/src/components/panes/CompliancePane.tsx`
  - `prototypes/pagespace-endgame/src/components/panes/RuntimePane.tsx`
  - `prototypes/pagespace-cli-architecture/src/components/panes/ArchitecturePane.tsx`
  - `docs/security/compliance-sovereignty-analysis.md` (mentions alerting as a need)
  - `tasks/tenant-epic-9-operational-tooling.md` (also future tense)
- Zero matches in `apps/`, `packages/`, `.github/workflows/`. No production alerting path exists.

**Why this is the most important finding in the audit:** GDPR Art 33's 72-hour clock starts when the controller "becomes aware" of a personal-data breach. Without anomaly detection, without alerts, and with rate limiting that's bypassed by horizontal scale, the awareness path is "a user notices something wrong and emails support." That is structurally incompatible with 72h notification of the supervisory authority.

**Recommendation:**
1. Replace `rate-limit-utils.ts` Map with a Redis-backed limiter using SETNX / sliding window. Redis is already a hard dependency.
2. Wire account lockouts (and failed-login bursts) to the `securityAuditLog` and emit a structured event.
3. Add a minimal alerting sink (Slack webhook or email) gated on three thresholds: account lockouts/min above N, mass-delete (>X resources by one user in M minutes), failed signature verifications on `/api/broadcast` and `/api/kick`.
4. Add an integration test that asserts the alerting sink is actually called when a synthetic anomaly is generated.

---

### F14 — Audit log hash-chain verifier
**Articles:** Art 32 (integrity)
**Severity:** OK with documented limits (the verifier itself is in scope here even though the hash-chain WRITER's PII handling is excluded)

**Evidence:** `packages/lib/src/monitoring/hash-chain-verifier.ts:134–349`

**Mechanism:**
1. Initialization: fetches the first entry containing the `chainSeed` (initialization salt for the chain).
2. Linking: each subsequent entry's `logHash` = SHA-256(serialized entry data || previous `logHash`). Forward chain.
3. Verification: re-computes the hash for each entry and compares against the stored `logHash`. Mismatch = tampering.
4. Batch processing: fetches entries in timestamp order, verifies up to a `limit` or all entries.
5. Break detection: stops at first invalid entry unless `stopOnFirstBreak=false` is passed.
6. Output: counts of valid / invalid / missing entries plus first-break details.

**Concurrency safety:** writers serialized via `ACTIVITY_CHAIN_LOCK_KEY` Postgres advisory lock (commit `d679bb1c` → #542). This addresses an earlier race condition.

**What it protects against:**
- In-place modification of any audited field (newValues, metadata, timestamps): hash mismatch detected.
- Deletion of an entry: the next entry's prev-hash linkage breaks.
- Insertion of a fake entry: requires re-minting all hashes from that point forward, which requires holding the secret-free hash-chain state — anyone with DB write access can do this.

**Limits to document explicitly (currently undocumented):**

1. **PII fields are excluded from the hash input** (commit `ed11d350` → #866). This is the right call for Art 17 (right to erasure) — once user identifiers are removed from the hash, anonymizing a user later doesn't break the chain. BUT it means the auditor cannot post-anonymization verify the *identity* of a data subject who acted on a record. Document explicitly as an Art 17 vs Art 32 trade-off.

2. **No external anchor.** The chain is verifiable only with database access. A DBA with table-write rights can rewrite both the data and the chain. There is no remote witness, no S3 object-lock copy, no blockchain-style external commitment. Recommend periodic export of the chain head (last `logHash` + sequence number) to write-once storage (S3 object-lock, immutable backups, or similar).

3. **O(n) verification.** `verifyHashChain()` scans entries sequentially. For multi-million-entry logs in production this may not finish in a reasonable request timeout. Recommend a chunked verifier with a checkpoint table: store `(chainSegmentEnd, hashAtThatPoint)` rows so a verifier can skip already-verified segments.

4. **Daily verification cron** — referenced in sovereignty doc §382-393 and #544 (`d74f4879 — verification alerting for audit hash chain`). Confirm in CI / deploy docs that the cron is actually scheduled in production. (This file does not contain the schedule wiring; it must live in a deployment manifest or systemd unit not present in this worktree.)

---

### F15 — Breach notification pipeline absent
**Articles:** Art 33, Art 34
**Severity:** CRITICAL (all modes)

**Evidence:**
- `find docs/ -iname "*incident*" -o -iname "*breach*" -o -iname "*runbook*"` returns only `docs/runbooks/tenant-migration.md`. The runbook directory exists but contains exactly one runbook, and it is for tenant migrations — not incident response, not breach response.
- No "notify users" code path. Generic email infrastructure exists (`packages/lib/services/email-service.ts`), but no breach-specific template, no batch sender, no admin action gated on a "breach declared" event.
- No DPA / DPO contact mechanism in the codebase (legal contact may live outside the repo, but nothing in code routes a breach notification to a DPO mailbox).
- No mechanism to compute the *scope* of a breach by data category — see F16 on the missing data-classification field.

**Why this is structurally critical:** Art 33 requires notification to the supervisory authority within 72 hours of awareness. Art 34 requires notification to data subjects "without undue delay" for high-risk breaches. The codebase has neither the awareness mechanism (F13) nor the notification mechanism (this finding). A breach today could not be reported on time even if detected by accident.

**Recommendation (minimum viable Art 33/34 readiness):**
1. Author `docs/runbooks/breach-response.md` with: who decides a breach has occurred, the 72h timeline checkpoints, the supervisory authority contact info, the DPO contact, the legal-review step, and the user-notification template.
2. Add a `securityIncidents` table (id, declaredAt, severity, scope query, scope userIds, status, notifiedAuthorityAt, notifiedSubjectsAt, summary).
3. Add an admin-only action that takes a list of affected user IDs (or a query) and sends a templated breach notice via the existing email service. Gate on the incident row.
4. Wire the alerting from F13 so the runbook's "step 1" (declare incident) is triggered by something other than a user complaint.

---

### F16 — Audit log schema lacks Art 30 record-of-processing fields
**Articles:** Art 30
**Severity:** MEDIUM

**Evidence:** `packages/db/src/schema/monitoring.ts:327–405`

**What `activityLogs` captures (request-level audit):**
- Actor: `userId`, `actorEmail`, `actorDisplayName` (the latter two are stripped from hash inputs by F14's PII-exclusion logic).
- Operation: `operation`, `resourceType`, `resourceId`, `metadata`.
- Context: `driveId`, `pageId`, timestamp.
- Indexes support forensic queries: `(userId, timestamp)`, `(driveId, timestamp)`, `(resourceType, resourceId)`.

**What Art 30 RoP requires that activityLogs do NOT capture:**
- Categories of data subjects (employees, customers, contractors, etc.) — no field.
- Categories of personal data being processed (name, email, IP, location, billing, health, etc.) — no `dataCategory` field.
- Recipients of disclosures (third parties, subprocessors) — not tracked per-operation.
- Retention period per category — not encoded; `activityLogs` itself has no `expiresAt` (compare to `aiUsageLogs` which does).
- Cross-border transfers — not tracked.

**Verdict:** the audit log is an *audit log*, not an Art 30 RoP. It supports forensic queries ("what did user X do during the breach window") but cannot answer organizational questions ("which categories of data are processed by which subprocessors with what retention").

**Cross-link:** Stream 3 (processors + transfers) should own the parallel Art 30 ledger.

**Recommendation:** Either (a) add `dataCategory` and `recipientId` columns to `activityLogs` and start tagging at the route level; or (b) maintain a separate compliance ledger document outside the codebase and accept that the codebase doesn't enforce Art 30. Option (a) is more defensible for an audit; option (b) is what most companies do in practice.

---

## 3. Deployment-mode divergence matrix

| Finding | `cloud` | `onprem` | `tenant` |
|---|---|---|---|
| F1 — App-layer PII encryption | HIGH | HIGH | HIGH |
| F2 — File storage at rest | MED (provider-dep) | CRIT | CRIT |
| F3 — Password hashing | OK (passwordless) | OK | OK |
| F4 — Session/bearer tokens | OK | OK | OK |
| F5a — HSTS staging gap | HIGH | n/a | HIGH |
| F5b — Internal service TLS | HIGH (multi-host) | LOW (single-host) | CRIT (multi-host) |
| F5c — Mobile cert pinning | HIGH (if mobile shipped) | n/a | HIGH (if mobile shipped) |
| F6 — PII in non-audit logs | HIGH | HIGH | HIGH |
| F7 — Search audit test fragile | MED | MED | MED |
| F8 — Broadcast endpoint authz | MED | MED | HIGH (cross-tenant risk) |
| F9 — Processor cache retention | CRIT | CRIT | CRIT |
| F10 — AI chat retention | OK (handoff to S1/S3) | OK | OK |
| F11 — Error reporting absence | OK | OK | OK |
| F12 — Secret rotation | MED | MED | MED |
| F13 — Detection + alerting | CRIT | HIGH (operator may watch) | CRIT |
| F14 — Hash-chain verifier limits | OK with caveats | OK | OK |
| F15 — Breach notification | CRIT | CRIT | CRIT |
| F16 — Art 30 RoP integration | MED | MED | MED |

---

## 4. Remediation priority

**P0 — Block any GDPR audit certification effort:**
- F9 — processor cache TTL + cleanup + encryption + tenant-scoped erasure
- F13 — replace in-process rate limiter with Redis; wire account-lockout to security audit; add alerting sink + threshold rules
- F15 — author breach-response runbook; add `securityIncidents` table and notification action

**P1 — 90 days:**
- F2 — document file-storage encryption requirement per deployment mode; cloud should enforce SSE-KMS via bucket policy
- F5b — document supported topology or add mTLS for split-host deployments
- F6 — extend logger redaction list, add lint rule against `console.*`, scrub `originalName` from worker logs
- F8 — sign broadcast audience constraints in the payload, or add server-side authz hook

**P2 — 180 days:**
- F1 — apply existing AES-256-GCM primitive to `users.email`, `users.name`; document plaintext page-content acceptance in DPIA
- F12 — scheduled token rotation reminders + admin "rotate now" affordance
- F14 — chunked verifier with checkpoint table; periodic chain-head export to immutable storage
- F16 — add `dataCategory` and `recipientId` columns to `activityLogs`, or maintain separate Art 30 ledger

**P3 — Housekeeping:**
- F3 — fix CLAUDE.md doc drift (remove "bcryptjs passwords" reference)
- F5a — make HSTS gating hostname-based, not `NODE_ENV`-based
- F11 — document the choice to not use external error reporting in DPIA

---

## 5. Cross-stream handoffs

| Surface | Owner stream | Why |
|---|---|---|
| File orphaning (sovereignty doc §167-187) | Stream 1 (rights/erasure) | Already covered there; F2 + F9 cross-link |
| AI chat retention TTL for active accounts | Stream 1 (storage limitation) | Mentioned but not deeply audited here |
| LLM provider transfers (Anthropic / OpenAI / etc) | Stream 3 (cross-border + processors) | F10 defers to it |
| Art 30 record of processing ledger | Stream 3 | F16 defers to it |
| Hash-chain WRITER PII handling | `pu/audit-pii-masking` branch | Excluded from §F14; verifier is in scope |
| Route-level audit coverage | `pu/audit-pii-masking` branch | Excluded |

---

## 6. Checklist of what was examined

**Specification + ground truth:**
- `tasks/gdpr-audit.md` (full)
- `docs/security/compliance-sovereignty-analysis.md` (claims spot-checked against code)
- `CLAUDE.md` (worktree project instructions; flagged stale `bcryptjs` reference)
- `git log` on `pu/audit-pii-masking` and `pu/pii-scrub-auth-logs` (both at master tip, no committed divergence; scope inferred from stated commits)

**Encryption primitives:**
- `packages/lib/src/encryption/encryption-utils.ts` (AES-256-GCM + scrypt KDF — verified in full)
- `packages/lib/src/auth/opaque-tokens.ts` (SHA-256 token hashing — verified)
- `packages/db/src/schema/auth.ts` (token storage shape — verified hashed at rest)
- `packages/db/src/schema/sessions.ts` (`tokenHash` column verified)
- `packages/db/src/schema/storage.ts` (file storage path field; no encryption metadata)

**Auth + bcrypt verification:**
- `grep bcrypt packages/lib/src` → 0 matches (verified)

**Security headers + transport:**
- `apps/web/src/middleware/security-headers.ts` (full read; HSTS conditional gate confirmed)
- `docker-compose.yml` (internal HTTP wiring confirmed)

**Logging surfaces:**
- `packages/lib/src/logging/logger.ts:130–165` (redaction list verified; no `email` key)
- `packages/lib/src/services/notification-email-service.ts:280–303` (userId log verified)
- `apps/processor/src/workers/text-extractor.ts` (full read; lines 12, 58–63, 65, 76 verified)
- `apps/processor/src/workers/ocr-processor.ts` (full read; lines 28, 36, 65–67, 80 verified; in-process rate limiter at line 8 noted)
- `apps/processor/src/workers/image-processor.ts` (sampled — uses sanitizeLogValue, OK)
- `apps/processor/src/workers/queue-manager.ts` (sampled — opaque IDs, OK)
- `apps/processor/src/workers/siem-delivery-worker.ts` (sampled — config errors only, OK)
- `apps/realtime/src/index.ts:280–340` (broadcast endpoint verified; HMAC-only authz confirmed)
- `apps/realtime/src/index.ts:516, 547, 757` (room-join authz checks confirmed via exploration)
- `packages/lib/src/auth/account-lockout.ts:90–175` (full read; email + userId logged at 151, 161 verified)
- `packages/lib/src/services/drive-search-service.ts` (sampled by exploration agent; ~line 408 regex timeout log)

**Search + minimization:**
- `apps/web/src/app/api/search/__tests__/gdpr-audit-compliance.test.ts` (full read; static regex pattern fragility verified)
- `apps/web/src/app/api/search/route.ts` (sampled — query NOT in audit details, OK)
- `apps/web/src/app/api/search/multi-drive/route.ts` (sampled — same)

**AI chat:**
- `packages/db/src/schema/chat.ts` (schema verified — content + userId stored, no automatic stripping)
- `apps/web/src/lib/ai/core/conversation-state.ts` (sampled — cookie holds conversationId only)
- `apps/web/src/lib/repositories/chat-message-repository.ts` (sampled — no external forwarding)
- Telemetry dependency grep across `apps/*/package.json packages/*/package.json` for `@sentry|posthog|datadog|bugsnag|rollbar|newrelic|@opentelemetry` → 0 matches (verified)

**Monitoring + breach:**
- `packages/lib/src/monitoring/hash-chain-verifier.ts:134–349` (mechanism verified)
- `packages/lib/src/monitoring/activity-logger.ts` (touched only to confirm it's the in-flight branch's surface; not deeply re-audited)
- `packages/lib/src/auth/rate-limit-utils.ts:1–60` (in-process Map verified; author comment about Redis confirmed)
- `packages/db/src/schema/monitoring.ts:327–405` (activityLogs schema reviewed for Art 30 fit)
- Alerting grep for `pagerduty|opsgenie|slack.*webhook|SLACK_WEBHOOK|alertmanager` → matches only in prototypes + docs + tasks; 0 in apps/packages/.github (verified)

**Secrets + CI:**
- `git ls-files | grep env` → only `.env.example*` templates (verified)
- `.github/workflows/security.yml:219–236` (TruffleHog config verified by exploration agent)

**Runbooks + breach docs:**
- `docs/runbooks/` → only `tenant-migration.md` (verified — no incident-response or breach runbook)
- `find docs/ -iname "*incident*" -o -iname "*breach*" -o -iname "*runbook*"` → only the tenant-migration runbook

**Deployment mode:**
- `packages/lib/src/deployment-mode.ts` (read by exploration agent; cloud / onprem / tenant divergence confirmed)
- `apps/web/src/middleware/security-headers.ts` (CSP differences across modes verified by exploration)

---

## Appendix A — Observations without a GDPR article hook

These items the auditor noticed but spec rule 2 forbids them as findings (they don't tie to a specific article).

1. **`CLAUDE.md` doc drift.** Says "bcryptjs passwords" but no bcrypt is used anywhere in `packages/lib/src`. Recent commits (#861, #894, b96d5220) confirm passwordless auth (passkeys + magic links). Recommend updating CLAUDE.md to "passkeys + magic-link tokens; SHA-256 hashed opaque session tokens".

2. **The two PII branches (`pu/audit-pii-masking` and `pu/pii-scrub-auth-logs`) currently sit at master tip with no committed divergence.** Whatever the in-flight agent is doing is uncommitted. Coordination should pull its actual diff before merging Stream 4 — anything Stream 4 misses *because* the in-flight work was assumed to cover it should be re-checked once that work lands.

3. **`apps/processor/src/workers/ocr-processor.ts:8` has its own in-process rate limiter Map for external OCR API calls.** Same shape as `rate-limit-utils.ts`. Reinforces the pattern in F13a — there are at least two places that need replacement.

4. **CLAUDE.md says password hashing is `bcryptjs`** — but the actual answer is "no passwords." If a future contributor takes CLAUDE.md at face value and adds a password-auth path, they may use bcrypt at whatever cost factor is convenient. Worth fixing for security culture even though it's not strictly a GDPR article violation.

5. **No `EMAIL` or `email` key in the logger redaction allow-list** despite the redaction infrastructure existing. The fix is one line.

---

*End of Stream 4 audit. Findings: 4 CRITICAL, 5 HIGH, 5 MEDIUM, 4 OK/observation. Recommended next step: address F9, F13, F15 before any external GDPR audit engagement.*
