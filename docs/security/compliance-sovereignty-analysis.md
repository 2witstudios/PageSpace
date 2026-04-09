# Compliance & Data Sovereignty Analysis

> **Purpose**: Identify PageSpace features that are fundamentally incompatible with
> specific compliance regimes and data sovereignty requirements, and catalog features
> that would require modification under higher regulatory scrutiny.
>
> **Date**: 2026-02-06
> **Scope**: Full codebase audit of external data flows, storage, processing, and retention

---

## Table of Contents

0. [Architectural History & Context](#0-architectural-history--context)
1. [Hard Incompatibilities](#1-hard-incompatibilities)
2. [Features Requiring Modification Under Scrutiny](#2-features-requiring-modification-under-scrutiny)
3. [What Already Works Well](#3-what-already-works-well)
4. [Compliance Regime Quick Reference](#4-compliance-regime-quick-reference)
5. [External Data Flow Inventory](#5-external-data-flow-inventory)
6. [Recommendations by Priority](#6-recommendations-by-priority)
7. [White-Label / Local Deployment Considerations](#7-white-label--local-deployment-considerations)

---

## 0. Architectural History & Context

**This section is critical for understanding why certain patterns exist.**

PageSpace was originally designed as a **local-first, self-hosted application**.
The original architecture assumed all data stayed on the user's own hardware:

- **Authentication** started as custom JWT-based auth with local user management
- **AI processing** was designed around Ollama (fully local inference)
- **Database content stored as plaintext** was a deliberate design decision — it
  enables regex search for the AI system. When everything runs locally, plaintext
  in your own PostgreSQL instance is not a sovereignty concern
- **File storage** on local disk with content-addressed hashing was designed for
  a single-owner deployment, not multi-tenant cloud

Over time, cloud-oriented features were layered on top of this local foundation:

- **Stripe** for subscription billing
- **Resend** for transactional email delivery
- **Google OAuth** and Google Calendar integration
- **Cloud AI providers** (Google AI, Anthropic, OpenAI, xAI, OpenRouter)
- **Google One Tap** authentication

This evolutionary path explains several patterns that might otherwise appear
inconsistent:

| Pattern | Why It Exists | Compliance Implication |
|---------|--------------|----------------------|
| Plaintext page content in DB | Enables AI regex search across all user content — designed for local-only deployment | Not a concern locally; becomes one when DB is cloud-hosted or when third parties access the instance |
| No file deletion on disk | Content-addressed storage assumed single owner on local hardware — orphaned files are the owner's own data | Breaks right-to-erasure when the deployment serves multiple users or tenants |
| JWT remnants alongside session tokens | Auth evolved from local JWT to cloud-ready opaque sessions | Session system is now strong; JWT vestiges are dead code, not a risk |
| Cloud services bolted onto local core | Each was added independently as the product grew | Creates a clear **feature boundary** for white-label: strip cloud layer, local core is sovereignty-clean |

**Key takeaway for meetings**: PageSpace has two distinct operational modes that
should be discussed separately in compliance conversations:

1. **Cloud mode** (current default) — includes Stripe, Resend, cloud AI, Google
   OAuth. This is where all sovereignty and compliance friction lives.
2. **Local mode** (original architecture) — Ollama AI, local auth, local
   storage, no external calls. This mode is inherently sovereignty-compliant
   but lacks billing, email verification, and cloud AI capabilities.

Any white-label or on-premise deployment conversation should start by
identifying which cloud features the customer actually needs, because the
compliant path is often "don't include them" rather than "make them compliant."

### AI Provider Consent System (Removed)

**What was removed**: A per-provider consent dialog that appeared before first use
of any cloud AI provider. This included an `aiProviderConsents` database table
tracking which providers each user had acknowledged, a `requiresConsent()` check
in the provider factory, and a frontend consent dialog component.

**Why it was removed**: The consent gate added friction to onboarding without
providing meaningful legal protection — users already bring their own API keys,
which is itself an affirmative opt-in to that provider's terms. The system was
removed to streamline the AI provider setup flow.

**Compliance implication**: For deployments where a centrally-managed API key is
shared across users (e.g., a PageSpace-hosted instance using a single OpenRouter
key), there is no longer an explicit record of each user's acknowledgment that
their data will be sent to a third-party AI provider. This is a gap for
high-compliance deployments (GDPR, HIPAA) where per-user consent records may
be required.

**Restoration path**: If needed for a regulated deployment, the consent system
can be restored from git history (search for `aiProviderConsents`,
`requiresConsent`, and `ai-consent-repository`). The schema migration for the
consents table would need to be regenerated.

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
user's prompt and the AI's response to the `ai_usage_logs` table.

**Status — partially resolved**:
- ~~Account deletion does NOT purge these logs~~ → **Fixed**: `deleteAiUsageLogsForUser()` purges on account deletion
- ~~No API endpoint to delete a user's AI usage history~~ → **Fixed**: account deletion handles this via FK cascade
- ~~Conversation messages retained indefinitely~~ → **Fixed**: 30-day purge cron for soft-deleted messages + FK cascade on account deletion

**Remaining gaps**:
- No TTL or automatic purge on `ai_usage_logs` for non-deleted accounts (logs accumulate indefinitely while account is active)
- No mechanism to selectively redact prompt/completion content

**Severity**: Downgraded from hard incompatibility to modification-required.
Account deletion now satisfies Art. 17 for erasure requests. The remaining gap
is retention minimization for active accounts.

**Affected compliance regimes**: GDPR Article 17 (right to erasure — now
partially satisfied), CCPA (right to delete — satisfied on account deletion),
data minimization (active account retention still unbounded).

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

### 2.1. No Data Retention Policy Engine (Partial)

**Current state**: Retention exists for some data categories but not all:
- ~~AI usage logs (indefinite)~~ → **Partial**: purged on account deletion; no TTL for active accounts
- ~~Conversation messages (indefinite)~~ → **Fixed**: 30-day purge cron for soft-deleted messages + FK cascade on account deletion
- Sessions and tokens → **Fixed**: TTL-based cleanup on cron schedule
- Page versions → **Fixed**: 30-day auto-retention with pinnable exemptions
- AI logs → **Fixed**: anonymize at 30 days, purge at 90 days (configurable via `AI_LOG_RETENTION_DAYS`)
- Activity/audit logs (indefinite — no retention policy)
- Client analytics events (indefinite — no retention policy)
- Security audit logs (indefinite — no retention policy)

**What's needed**: Configurable retention windows for the remaining categories
(activity logs, analytics, security audit logs) and admin configuration UI.

**Effort**: Medium. Core retention engine and cron infrastructure exists; needs
extension to remaining data categories and admin-facing configuration.

---

### 2.2. ~~Incomplete Data Subject Access / Export~~ → RESOLVED

**Current state**: Data subject access and export is implemented:
- **User DSAR export**: `GET /api/account/export` — ZIP archive with JSON files
  covering profile, drives, pages, messages, files metadata, activity logs,
  AI usage logs, and tasks. Rate-limited to 1 export per 24 hours.
- **Admin DSAR endpoint**: `GET /api/admin/users/[userId]/export` — admin-only
  endpoint for processing data subject access requests. Logs which admin
  accessed which user's data for audit trail.

**Remaining gap**: No "which third parties received data" view — users cannot
see a summary of which AI providers, integrations, or external services
processed their data.

**Effort**: Low for the remaining gap (query integration credentials +
AI usage logs by provider).

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

**Why it's this way**: This is a deliberate architectural decision from
PageSpace's local-first origins. Plaintext content enables the AI system's
regex search across all user content — a core feature. When the database lives
on your own hardware, plaintext in your own PostgreSQL is not a sovereignty
concern. This only becomes a compliance issue when the database is cloud-hosted,
when third parties can access the instance, or when regulations like HIPAA
mandate encryption at rest regardless of hosting.

**What's needed for HIPAA/high-security**: PostgreSQL TDE (Transparent Data
Encryption) or application-layer encryption for sensitive content fields.

**Effort**: High. TDE is infrastructure-level. Application-layer encryption
requires schema changes and **breaks the AI regex search feature** — which is
the reason plaintext exists. Any encryption-at-rest solution must either
preserve search capability (e.g., TDE at the volume/tablespace level, which is
transparent to queries) or accept that AI search over encrypted content requires
a fundamentally different approach (searchable encryption, separate search
index, etc.).

---

### 2.7. CDN Dependencies Load External Scripts

**Current state**: The application loads external scripts from:
- `accounts.google.com` (One Tap)
- `js.stripe.com` (payment UI)

**Why it matters**: In air-gapped or highly restricted environments, these
external loads will fail. Some compliance regimes require Subresource Integrity
(SRI) hashes for all external scripts.

**What's needed**: Keep Monaco and PDF.js self-hosted (completed). For remaining
third-party scripts, note that Stripe.js and Google One Tap do not support SRI
(their scripts are dynamically generated and versioned). The primary
compensating control is strict CSP allowlisting, which is already in place:
`script-src` allows only `accounts.google.com`, and `frame-src` allows
`accounts.google.com` and `js.stripe.com`. SRI remains applicable only for
self-hosted assets where we control versioning.

**Effort**: Low. CSP allowlisting already configured; no further hardening
required for Stripe/Google integrations beyond current controls.

---

### 2.8. Google Calendar Integration Credential Storage

**Current state**: OAuth tokens for Google Calendar are stored as encrypted
integration credentials. Calendar data (events, attendees) is fetched and
cached.

**What's needed for compliance**: Clear disclosure of what calendar data is
accessed, retention limits for cached calendar data, and token revocation UI.

**Effort**: Low-medium.

---

### 2.9. Security Audit Log Integrity Verification (Partially Resolved)

**Current state**: Security audit chain integrity is now verified automatically:
- **Fixed (#541)**: Hash chain GDPR-safe — PII fields excluded from hash
  computation so anonymization doesn't break the chain
- **Fixed**: Daily verification cron (`/api/cron/verify-audit-chain`) recomputes
  hashes and verifies chain links. HMAC-signed cron requests. Pluggable
  `ChainAlertHandler` for Slack/email/PagerDuty alerting.

**Remaining gap**: Activity log hash chain still broken by anonymization — PII
fields are included in `serializeLogDataForHash()`. Fix in progress on branch
`pu/hash-chain-pii`.

**Effort**: Low. Security audit chain is done; activity log chain fix follows
the same pattern.

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

The local-first architecture means the core of PageSpace is already
sovereignty-clean. These features are compliance-positive as-is:

| Feature | Status | Notes |
|---------|--------|-------|
| Opaque session tokens (not JWTs) | Strong | Server-controlled, instantly revocable (evolved from original JWT system) |
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
| 7 | HTTP requests | accounts.google.com | Google One Tap render | IP address, cookies | Optional |

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

4. ~~**Build data subject export endpoint**~~ — **DONE**. `GET /api/account/export`
   (user) and `GET /api/admin/users/[userId]/export` (admin DSAR). ZIP with JSON.
5. **Add consent management for AI providers** — No disclosure or consent record
   when selecting external AI providers.
6. ~~**Implement conversation message hard-delete**~~ — **DONE**. 30-day purge cron
   hard-deletes soft-deleted messages. FK cascade on account deletion.
7. **Document data retention schedules** — No formal retention policy exists for
   any data category.

### P2 — Required for SOC 2 / enterprise sales

8. **Add audit log integrity verification cron** — Hash chain exists but is never
   verified.
9. **Standardize bcrypt cost factor** — Minor inconsistency (cost 10 vs 12).
10. **Add AI provider DPA references** — Link to each provider's data processing
    terms.

### P3 — Required for HIPAA / FedRAMP / air-gapped

12. **Implement database encryption at rest (TDE)** — Content stored plaintext
    (by design for AI search; TDE preserves search while encrypting at volume
    level).
13. **Self-host all external assets** — Full air-gap capability.
14. **Replace Resend with self-hosted SMTP** — Email must stay on-premise.
15. **Replace Stripe with on-premise billing** — If required by regime.

---

## 7. White-Label / Local Deployment Considerations

PageSpace's local-first origins mean a sovereignty-clean white-label deployment
is achievable by **removing the cloud layer** rather than re-engineering the
core. This section maps what to strip vs. what to keep.

### 7.1. Cloud Features to Remove for Local White-Label

These features were added after the original local architecture and would need
to be stripped or replaced for a compliance-clean on-premise deployment:

| Cloud Feature | Replacement for Local | Effort | Notes |
|---------------|----------------------|--------|-------|
| Stripe billing | Remove entirely, or license-key model | Low-medium | No billing needed for single-tenant on-prem |
| Resend email | Self-hosted SMTP (Postfix, etc.) | Medium | Only needed if email verification is required |
| Google OAuth | Remove; use local email+password auth only | Low | Original auth system already exists |
| Google One Tap | Remove | Trivial | UI-only removal |
| Google Calendar | Remove | Low | Optional integration |
| Cloud AI providers | Remove from config; Ollama/LM Studio only | Low | Provider factory already supports this |
| CDN scripts (Monaco, PDF.js) | Completed: self-hosted | N/A | No external CDN dependency for Monaco/PDF.js |

### 7.2. What Stays as-Is for Local White-Label

The original local core requires no changes for sovereignty compliance:

- Local PostgreSQL (plaintext content is fine — it's the customer's own DB)
- Local file storage (content-addressed, on customer hardware)
- Local AI via Ollama/LM Studio
- Socket.IO real-time (internal Docker network)
- File processing (Sharp, Tesseract, Mammoth — all local)
- All analytics and telemetry (already local-only, stored in PostgreSQL)
- Session-based auth (opaque tokens, server-controlled)
- CSRF, rate limiting, security headers

### 7.3. Meeting Talking Points

When entering compliance or white-label conversations, use this framing:

**Safe to promise**:
- "All user content (pages, files, conversations) is stored locally and never
  leaves the deployment boundary"
- "AI processing can run entirely on-premise via local models"
- "No telemetry or analytics data is sent to external vendors"
- "Real-time collaboration runs entirely within the local network"
- "Authentication and session management are fully self-contained"

**Must qualify**:
- "AI features" — always specify "with local models" or name the specific
  provider and its data handling terms
- "Email notifications" — currently requires Resend; self-hosted SMTP is a
  known replacement path
- "Payment processing" — only relevant for SaaS mode, not on-prem

**Do not promise without engineering work**:
- GDPR right-to-erasure compliance (file deletion gap remains — DB erasure is done)
- ~~Data subject export / portability~~ → **Resolved**: DSAR export endpoints exist
- Configurable data retention policies (partial — AI logs and messages have retention; activity/analytics/audit logs do not)
- ~~Formal audit log integrity verification~~ → **Resolved**: daily verification cron with alerting (activity log chain fix in progress)
- Database encryption at rest (TDE needed for regulated industries)

**Never promise** (without fundamental changes):
- Cloud AI provider compliance with data residency laws
- HIPAA compliance with cloud AI or Resend email
- FedRAMP authorization (requires authorized infrastructure stack)
- Air-gapped deployment without removing all remaining external integrations
