# Compliance & Data Sovereignty Analysis

> **Purpose**: Identify PageSpace features that are fundamentally incompatible with
> specific compliance regimes and data sovereignty requirements, and catalog features
> that would require modification under higher regulatory scrutiny.
>
> **Date**: 2026-02-06
> **Scope**: Full codebase audit of external data flows, storage, processing, and retention

---

## Table of Contents

1. [Hard Incompatibilities](#1-hard-incompatibilities)
2. [Features Requiring Modification Under Scrutiny](#2-features-requiring-modification-under-scrutiny)
3. [What Already Works Well](#3-what-already-works-well)
4. [Compliance Regime Quick Reference](#4-compliance-regime-quick-reference)
5. [External Data Flow Inventory](#5-external-data-flow-inventory)
6. [Recommendations by Priority](#6-recommendations-by-priority)

---

## 1. Hard Incompatibilities

These are features that **cannot satisfy** certain compliance constraints without
fundamental architectural changes. Do not promise these in regulated contexts.

### 1.1. AI Chat with Cloud Providers → Data Sovereignty / GDPR / HIPAA / FedRAMP

**What happens**: When a user sends a message in AI chat, the full conversation
history, system prompts, page titles, drive names, breadcrumbs, and user ID are
sent to the selected external AI provider (Google, Anthropic, OpenAI, xAI, or
OpenRouter).

**Why it's incompatible**:
- **Data residency**: No control over which geographic region processes the data.
  Provider APIs route globally with no region pinning.
- **Data retention at provider**: Each provider has its own retention policy that
  PageSpace cannot enforce or audit. OpenRouter adds a second intermediary hop
  with its own unknown retention.
- **Data minimization**: The system sends organizational metadata (drive names,
  page hierarchy, breadcrumbs) that is unnecessary for inference but exposes
  organizational structure.
- **User identification**: `userId` is sent in `experimental_context`, enabling
  cross-request correlation in provider logs.
- **No DPA chain**: No Data Processing Agreements exist with AI providers, and
  the system has no mechanism to enforce provider-side obligations.

**Affected compliance regimes**: GDPR (Articles 44-49 cross-border transfer),
HIPAA (BAA required), SOC 2 Type II (vendor management), FedRAMP (data
sovereignty), CCPA (service provider agreements), any data residency law
(Germany, France, Australia, China, Russia, etc.).

**Workaround**: Ollama (local) and LM Studio (local) providers keep all data
on-premise. But promising "AI features" in a compliance context without
qualifying "local models only" is dangerous.

**Key files**:
- `apps/web/src/app/api/ai/chat/route.ts` (lines 797-836: data sent to providers)
- `apps/web/src/lib/ai/core/provider-factory.ts` (all provider initialization)
- `apps/web/src/lib/ai/core/ai-providers-config.ts` (provider catalog)

---

### 1.2. AI Usage Logging → Right to Erasure / GDPR Article 17

**What happens**: Every AI interaction logs the first 1000 characters of the
user's prompt and the AI's response to the `ai_usage_logs` table. This data is
stored indefinitely with no automatic retention policy or deletion mechanism.

**Why it's incompatible**:
- No TTL or automatic purge on `ai_usage_logs`
- No API endpoint to delete a user's AI usage history
- No mechanism to selectively redact prompt/completion content
- Account deletion does NOT purge these logs
- Conversation `messages` table retains full message content indefinitely

**Affected compliance regimes**: GDPR Article 17 (right to erasure), CCPA
(right to delete), any "right to be forgotten" regulation.

**Key files**:
- `packages/db/src/schema/monitoring.ts` (lines 144-203: `ai_usage_logs` schema)
- `packages/db/src/schema/conversations.ts` (full message storage)

---

### 1.3. File Storage Orphaning → Right to Erasure / Data Retention

**What happens**: When a page is permanently deleted or a user account is
deleted, the actual files on disk (`/data/files/{contentHash}/`) are **never
removed**. Only database references are cascade-deleted.

**Why it's incompatible**:
- Files persist on disk forever after deletion
- No `deleteOriginal()` or `purgeFile()` method exists in content store
- Content-addressed deduplication complicates deletion (shared hashes)
- Account deletion only removes the user's avatar, not their uploaded files
- No bulk file purging capability exists

**Affected compliance regimes**: GDPR Article 17, CCPA, HIPAA (data disposal),
SOC 2 (data lifecycle management), any data retention policy.

**Key files**:
- `apps/processor/src/cache/content-store.ts` (no deletion methods)
- `apps/web/src/app/api/trash/[pageId]/route.ts` (DB delete only, no file cleanup)
- `apps/web/src/app/api/account/route.ts` (lines 216-231: incomplete file cleanup)

---

### 1.4. Stripe Payment Processing → Data Residency

**What happens**: All payment processing goes through Stripe's infrastructure.
Stripe.js loads from `js.stripe.com` in the browser. Webhook events flow from
Stripe's servers.

**Why it's incompatible**: For jurisdictions requiring all data processing
(including payment) to occur within national borders, Stripe may not have
in-country processing available. Stripe processes data in the US by default.

**Affected compliance regimes**: Strict data residency laws (Russia, China,
certain EU interpretations requiring in-country processing).

**Key files**:
- `apps/web/src/lib/stripe-config.ts`
- `apps/web/src/app/api/stripe/webhook/route.ts`

---

### 1.5. Resend Email Service → Data Residency / PHI Transmission

**What happens**: Verification emails and collaboration notifications are sent
through Resend's external API. User email addresses and verification tokens
leave the system.

**Why it's incompatible**: Email content and addresses transit through Resend's
infrastructure with no guarantee of geographic processing location.

**Affected compliance regimes**: HIPAA (if emails contain PHI), strict data
residency, any regime requiring all PII processing to be on-premise.

**Key files**:
- `packages/lib/src/services/email-service.ts`

---

## 2. Features Requiring Modification Under Scrutiny

These features work today but would need changes to pass audits in regulated
environments.

### 2.1. No Data Retention Policy Engine

**Current state**: No automatic data expiration exists for:
- AI usage logs (indefinite)
- Conversation messages (indefinite, soft-delete only via `isActive` flag)
- Activity/audit logs (indefinite)
- Client analytics events (indefinite)
- Security audit logs (indefinite)

**What's needed**: Configurable retention windows with automatic purge jobs.
Most compliance frameworks require documented retention schedules.

**Effort**: Medium. Requires cron jobs and admin configuration UI.

---

### 2.2. Incomplete Data Subject Access / Export

**Current state**: No mechanism exists for a user to:
- Export all their personal data (GDPR Article 15 / CCPA right to know)
- See which third parties received their data
- Download their conversation history, uploaded files, or activity logs

**What's needed**: Data export endpoint that packages all user data in a
portable format (JSON/ZIP).

**Effort**: Medium-high. Requires aggregating data across multiple tables and
file storage.

---

### 2.3. No Consent Management for Third-Party Data Processing

**Current state**: When a user selects an AI provider, there's no explicit
disclosure that their data will be processed by that third party. No consent
record is stored. No DPA reference is provided.

**What's needed**:
- Consent dialog when configuring external AI providers
- Record of consent with timestamp
- Link to each provider's DPA/privacy policy
- Ability to withdraw consent

**Effort**: Medium. UI + database changes.

---

### 2.4. AI Provider Data Minimization

**Current state**: Every AI request sends:
- Full conversation history (no windowing)
- `userId` in `experimental_context`
- Drive names, page titles, breadcrumbs, page hierarchy
- System prompts (which may contain proprietary instructions)

**What's needed**:
- Strip `userId` from provider-bound context
- Make metadata inclusion opt-in per provider
- Implement conversation windowing to limit history sent
- Option to anonymize organizational context

**Effort**: Low-medium. Changes concentrated in `chat/route.ts`.

---

### 2.5. Password Hash Cost Inconsistency

**Current state**: Signup uses bcrypt cost 12, but password change uses cost 10.
While both are acceptable, the inconsistency would be flagged in a security
audit.

**What's needed**: Standardize on cost 12 everywhere.

**Effort**: Trivial. One-line change.

**Key files**:
- `apps/web/src/app/api/account/password/route.ts`

---

### 2.6. No Encryption at Rest for Database Content

**Current state**: API keys are encrypted (AES-256-GCM). But page content,
conversation messages, file metadata, and user profiles are stored as plaintext
in PostgreSQL.

**What's needed for HIPAA/high-security**: PostgreSQL TDE (Transparent Data
Encryption) or application-layer encryption for sensitive content fields.

**Effort**: High. TDE is infrastructure-level. Application-layer encryption
requires schema changes and breaks search/indexing.

---

### 2.7. CDN Dependencies Load External Scripts

**Current state**: The application loads external scripts from:
- `cdn.jsdelivr.net` (Monaco editor)
- `unpkg.com` (PDF.js worker)
- `accounts.google.com` (One Tap)
- `js.stripe.com` (payment UI)

**Why it matters**: In air-gapped or highly restricted environments, these
external loads will fail. Some compliance regimes require Subresource Integrity
(SRI) hashes for all external scripts.

**What's needed**: Self-host Monaco and PDF.js. Add SRI hashes for any remaining
external scripts.

**Effort**: Medium. Bundle Monaco and PDF.js locally.

---

### 2.8. Google Calendar Integration Credential Storage

**Current state**: OAuth tokens for Google Calendar are stored as encrypted
integration credentials. Calendar data (events, attendees) is fetched and
cached.

**What's needed for compliance**: Clear disclosure of what calendar data is
accessed, retention limits for cached calendar data, and token revocation UI.

**Effort**: Low-medium.

---

### 2.9. Security Audit Log Integrity Verification

**Current state**: Tamper-evident hash chain exists in `security_audit_log` but
no automated verification process runs to detect tampering.

**What's needed**: Periodic chain integrity verification job with alerting.

**Effort**: Low. The infrastructure exists; needs a cron job.

---

### 2.10. Session Token in Single Cookie Without Binding

**Current state**: Session tokens are opaque and database-backed (strong), but
not bound to the client's TLS session or device fingerprint. A stolen cookie
works from any device.

**What's needed for high-security**: Token binding to client certificate or
device fingerprint for session fixation resistance beyond current protections.

**Effort**: Medium-high.

---

## 3. What Already Works Well

These are compliance-positive features that are already implemented correctly.

| Feature | Status | Notes |
|---------|--------|-------|
| Opaque session tokens (not JWTs) | Strong | Server-controlled, instantly revocable |
| Tamper-evident audit logging | Strong | SHA-256 hash chain with transaction locking |
| API key encryption (AES-256-GCM) | Strong | Per-field encryption with scrypt key derivation |
| CSRF protection (dual-layer) | Strong | SameSite=strict + HMAC-SHA256 tokens |
| Rate limiting (distributed) | Strong | Redis-backed, fail-closed in production |
| Account lockout | Strong | 10 attempts → 15-min lockout |
| Activity log anonymization on account deletion | Good | Deterministic hash preserves audit trail |
| All analytics/telemetry stored locally | Strong | No Sentry, PostHog, GA, or external analytics |
| Real-time collaboration fully local | Strong | Socket.IO within Docker network only |
| File processing fully local | Strong | Sharp, Tesseract, Mammoth - no external APIs |
| Security headers (CSP, HSTS, etc.) | Strong | Comprehensive header set |
| Local deployment architecture | Strong | Docker on local hardware, no cloud dependency |
| Ollama/LM Studio AI option | Strong | Fully local AI inference path exists |

---

## 4. Compliance Regime Quick Reference

Use this table to quickly assess what you can and cannot promise.

| Regime | AI Chat (Cloud) | AI Chat (Ollama) | File Storage | Email (Resend) | Payments (Stripe) | Core App |
|--------|-----------------|-------------------|--------------|----------------|-------------------|----------|
| **GDPR** | Blocked | OK | Needs file deletion | Needs DPA | Needs DPA | Needs retention policy + export |
| **HIPAA** | Blocked (no BAA) | OK with TDE | Needs encryption at rest | Blocked (PHI risk) | OK (Stripe is PCI) | Needs TDE + audit enhancements |
| **SOC 2 Type II** | Needs vendor mgmt | OK | Needs data lifecycle | Needs vendor review | OK | Needs retention + access controls |
| **FedRAMP** | Blocked | OK if authorized | Needs FedRAMP infra | Blocked | Blocked | Needs authorized cloud |
| **CCPA** | Needs service provider agreement | OK | Needs deletion capability | Needs SPA | OK | Needs data export |
| **Data Residency (strict)** | Blocked | OK | OK (local) | Blocked | Blocked | OK if on-prem |
| **Air-Gapped** | Blocked | OK | OK | Blocked | Blocked | Needs self-hosted CDN assets |

**Legend**: Blocked = fundamentally incompatible today. Needs X = requires specific work. OK = compliant as-is.

---

## 5. External Data Flow Inventory

Every path where data leaves the PageSpace deployment boundary.

| # | Data Type | Destination | Trigger | User Data Included | Configurable? |
|---|-----------|-------------|---------|-------------------|---------------|
| 1 | Chat messages + context | AI Provider (Google/Anthropic/OpenAI/xAI/OpenRouter) | User sends AI message | Full conversation, userId, org structure | Yes - can use Ollama instead |
| 2 | Image attachments | AI Provider (for vision) | User attaches image to AI chat | Image content (base64 or URL) | Yes - can use Ollama instead |
| 3 | User email + tokens | Resend API | Signup, password reset, invitations | Email address, verification token | No alternative configured |
| 4 | Payment info | Stripe | Subscription purchase | Payment details (handled by Stripe.js) | No alternative configured |
| 5 | OAuth credentials | Google | Google sign-in | Email, profile info | Optional (email auth available) |
| 6 | Calendar tokens | Google Calendar API | Calendar sync | Calendar events, attendees | Optional feature |
| 7 | HTTP requests | cdn.jsdelivr.net, unpkg.com | Page load (Monaco, PDF.js) | IP address, User-Agent only | Can self-host |
| 8 | HTTP requests | accounts.google.com | Google One Tap render | IP address, cookies | Optional |

---

## 6. Recommendations by Priority

### P0 — Must fix before any compliance conversation

1. **Implement file deletion on page/account deletion** — Files persist forever
   on disk after deletion. This is the single biggest compliance gap.
2. **Add data retention policy for `ai_usage_logs`** — Prompt/completion content
   stored indefinitely with no purge mechanism.
3. **Strip `userId` from AI provider `experimental_context`** — Unnecessary PII
   leakage to third parties.

### P1 — Required for GDPR/CCPA readiness

4. **Build data subject export endpoint** — Users cannot export their data today.
5. **Add consent management for AI providers** — No disclosure or consent record
   when selecting external AI providers.
6. **Implement conversation message hard-delete** — Only soft-delete (`isActive`)
   exists today.
7. **Document data retention schedules** — No formal retention policy exists for
   any data category.

### P2 — Required for SOC 2 / enterprise sales

8. **Self-host Monaco and PDF.js** — Eliminates external CDN dependency.
9. **Add audit log integrity verification cron** — Hash chain exists but is never
   verified.
10. **Standardize bcrypt cost factor** — Minor inconsistency (cost 10 vs 12).
11. **Add AI provider DPA references** — Link to each provider's data processing
    terms.

### P3 — Required for HIPAA / FedRAMP / air-gapped

12. **Implement database encryption at rest (TDE)** — Content stored plaintext.
13. **Self-host all external assets** — Full air-gap capability.
14. **Replace Resend with self-hosted SMTP** — Email must stay on-premise.
15. **Replace Stripe with on-premise billing** — If required by regime.
