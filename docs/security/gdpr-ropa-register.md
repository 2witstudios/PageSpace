# GDPR Records of Processing Activities (RoPA) Register

**Issue:** #931, #951 · **Articles:** GDPR Art 30 · **Audience:** Security/compliance, engineering leads

## Context

Article 30 requires a controller to maintain a record of processing activities.
This register covers the processing activities we actually have code for today —
authentication, billing, AI inference, notifications, security/audit logging, and
file storage. "Categories of data" below draws on the canonical per-user data
inventory already enumerated for data-portability exports in
`docs/security/gdpr-export-format.md` (`profile`, `drives`, `pages`, `messages`,
`files-metadata`, `activity`, `ai-usage`, `tasks`, `sessions`, `notifications`,
`display-preferences`, `personalization`).

Every cell below is either a fact backed by a file/line citation, or an explicit
`[TODO]` where the answer requires legal/ops input this document can't
manufacture (subprocessor DPAs, infra-level bucket regions, log-table retention
that isn't governed by a retention-policy doc yet). Do not treat a `[TODO]` as
"no risk" — treat it as "not yet answered."

## Register

| Processing activity | Purpose | Categories of data subjects/data | Recipients | Retention | Transfers | Security measures |
|---|---|---|---|---|---|---|
| **Authentication** (passkeys, magic links, sessions) | Verify identity and authorize account access | Data subjects: registered users. Data: `users.email`/`name`, passkey public keys (`passkeys` table — private key never leaves the authenticator), hashed session/device/magic-link/MCP tokens, IP/user-agent on `deviceTokens` | Internal only, plus Resend for magic-link email delivery | Magic link 5 min · email-verify token 24h default · web session 7d + 7d post-expiry purge · device token 90d · desktop WS token 7d · passkeys: no expiry (`packages/lib/src/auth/magic-link-constants.ts`, `constants.ts`, `device-auth-utils.ts`, `token-lifecycle-policy.ts`) | None (internal DB) | Tokens are SHA3-256 hash-only at rest, never the raw value (`packages/lib/src/auth/token-utils.ts:42-44`); access gated by `packages/lib/src/permissions/` |
| **Billing** (Stripe) | Process subscriptions and payment | Data subjects: paying customers. Data: email, name, internal `userId` (sent to Stripe as metadata), `subscriptions`/`stripeEvents` tables | Stripe (payment-processor subprocessor; card data is collected client-side via Stripe Elements and never reaches app servers — `apps/web/src/components/billing/StripeProvider.tsx`) | `[TODO: engineering/legal to confirm retention window for `subscriptions`/`stripeEvents` — not covered by `docs/security/audit-log-retention-policy.md`]` | `[TODO: confirm Stripe DPA/SCC coverage for the account's region]` | Access to billing data gated by `packages/lib/src/permissions/`; webhook processing is idempotency-ledgered (`stripeEvents`) |
| **AI inference** (prompt/content processing) | Provide AI chat, assistance, and search across the product | Data subjects: users submitting prompts (and any third parties named in that content). Data: `chat_messages.content`/`channel_messages.content` (plaintext), tool calls/results | **OpenRouter** is the single subprocessor for every cloud vendor (OpenAI/Anthropic/Google/xAI model IDs are forwarded verbatim — `apps/web/src/lib/ai/core/ai-providers-config.ts`, `provider-factory.ts`); onprem deployments instead use Ollama (local, no transfer) or Azure OpenAI/LM Studio (deployment-configured endpoint) | `ai_usage_logs`: `RETENTION_AI_USAGE_LOGS_DAYS`, default 90 (`docs/security/audit-log-retention-policy.md`). Message/page content itself: `[TODO: no retention policy exists for `chat_messages`/`pages` content tables]` | `[TODO: confirm OpenRouter DPA/SCC status]` — the erasure pipeline already records gateway-routed cloud providers as ZDR-reliant, skips local providers, and flags unrecognized ones `manual_review` (`docs/security/data-subject-request-runbook.md`, "Sub-processor propagation") | Message/page visibility gated by `packages/lib/src/permissions/`; erasure pipeline propagates deletion to AI providers. **Content is plaintext at rest** — explicitly scoped out of the field-encryption epic pending a searchable-encryption design (`docs/security/pii-encryption-design.md`, "Per-column decisions" + "Why content is scoped OUT"). See risk R2 in the [AI-processing DPIA](gdpr-dpia-ai-processing.md). |
| **Notifications** (email, push) | Deliver transactional and product notifications | Data subjects: users. Data: email address + notification content, push tokens (APNs live; FCM implemented — `packages/lib/src/notifications/push-notifications.ts` sends the device registration token and notification payload to Google FCM HTTP v1, dormant only until the Android client registers a token; Web Push remains a schema stub with sends unimplemented) | Resend (email subprocessor), Apple APNs (iOS push subprocessor), Google LLC / Firebase Cloud Messaging (Android push subprocessor) | `[TODO: no TTL found for `emailNotificationLog`/`pushNotificationTokens` — confirm with engineering]` | `[TODO: confirm Resend/Apple/Google-FCM DPA/SCC coverage]` | Per-user opt-in preferences (`emailNotificationPreferences`); Resend suppression-list is wired into the erasure pipeline (`packages/lib/src/compliance/erasure/resend-suppression-client.ts`) |
| **Security/audit logging** | Security monitoring, forensic investigation, legal-obligation record-keeping | Data subjects: all users and admins. Data: event type, `userId`, IP address, user-agent, geolocation, risk score, per `security_audit_log` schema | Internal only, admin-role restricted | **Infinite** — tamper-evident hash chain, Art 17(3)(b) legal-obligation basis (`docs/security/audit-log-retention-policy.md`) | None | IP address is AES-256-GCM encrypted with a blind index for equality lookups whenever `ENCRYPTION_KEY` is set (`packages/lib/src/encryption/audit-ip-crypto.ts`); tamper-evident hash chain; disputed-retention path via `docs/security/gdpr-pseudonymization-runbook.md`; admin-only access via `packages/lib/src/permissions/` |
| **File storage** | Store user-uploaded files and attachments | Data subjects: users uploading files (and any third parties captured in file content). Data: file bytes, `files` table metadata, `AttachmentMeta` (originalName, size, mimeType, contentHash) | Tigris (S3-compatible object storage, configured subprocessor) or AWS S3 as an alternative (`apps/processor/src/s3-client.ts`) | `[TODO: bucket lifecycle/region are infra/env config, not in this repo — confirm with deployment ops]` | `[TODO: same — deployment-specific, not determinable from code]` | AES-256-GCM envelope encryption for server-side-only extracted-text caches whenever `ENCRYPTION_KEY` is set; original files/binary previews encrypted only if `FILE_ENCRYPTION_ENABLED=true` (default OFF — cloud relies on Tigris/infra disk encryption instead, since browsers can't decrypt an app-layer envelope through a presigned URL); `metadata.json` sidecars are not yet encrypted (tracked follow-up) (`docs/security/file-encryption-at-rest.md`); access gated by `packages/lib/src/permissions/file-access.ts: canUserAccessFile` |

## Cross-references

- `docs/security/pii-encryption-design.md` — field-level encryption decisions and current cutover status
- `docs/security/file-encryption-at-rest.md` — object-storage envelope encryption
- `docs/security/encryption-in-transit.md` — transport security (HSTS, internal service-to-service, mobile cert pinning)
- `docs/security/audit-log-retention-policy.md` — retention windows and archival mechanics
- `docs/security/data-subject-request-runbook.md` — erasure pipeline and sub-processor propagation
- `packages/lib/src/permissions/` — centralized access-control functions cited throughout this register
- [`docs/security/gdpr-dpia-ai-processing.md`](gdpr-dpia-ai-processing.md) — risk assessment for the AI inference row

## Out of scope

This register documents processing activities as implemented in code. It does
not attempt to verify subprocessor Data Processing Agreements, Standard
Contractual Clauses, or the actual deployed cloud region for third-party
services (Stripe, OpenRouter, Resend, Apple, Tigris/AWS) — those are legal and
deployment-ops follow-ups tracked as `[TODO]` above, not engineering facts this
document can assert.
