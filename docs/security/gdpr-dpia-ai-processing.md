# Data Protection Impact Assessment: AI Prompt/Content Processing

**Issue:** #930 · **Articles:** GDPR Art 35, Art 25, Art 32 · **Audience:** Security/compliance, engineering leads

## 1. Description of processing

**Nature.** Users submit prompts and content (chat messages, channel messages,
page content referenced in AI actions) that are sent to a large-language-model
provider for inference, and the resulting conversation is persisted. A
first-party analytics table (`ai_usage_logs`) separately records usage metadata
for billing/observability.

**Scope.** All AI chat, assistance, and search-adjacent features across the
product. Every cloud AI vendor (OpenAI, Anthropic, Google, xAI) is reached
through a single subprocessor, **OpenRouter**, which forwards the
vendor-prefixed model ID verbatim (`apps/web/src/lib/ai/core/ai-providers-config.ts`,
`provider-factory.ts`) — there are no separate direct SDK integrations for
these vendors. Onprem deployments instead route to Ollama (runs locally, no
third-party transfer), or to an operator-configured Azure OpenAI or LM Studio
endpoint.

**Context.** `chat_messages.content` and `channel_messages.content` are stored
in Postgres as plaintext (`packages/db/src/schema/core.ts`, `schema/chat.ts`).
`ai_usage_logs` is retained for `RETENTION_AI_USAGE_LOGS_DAYS` (default 90 —
`docs/security/audit-log-retention-policy.md`).

**Purpose.** AI inference is core product functionality (chat, assistance,
search), not incidental analytics. `ai_usage_logs` supports billing accuracy
and abuse/anomaly monitoring.

## 2. Necessity and proportionality assessment

- AI processing is the product's primary value proposition — there is no
  lesser-data way to deliver conversational AI features; the content sent to a
  provider is exactly the content the user chose to submit.
- Data minimization is structural rather than per-request: routing all cloud
  vendors through a single OpenRouter funnel means one subprocessor
  relationship to govern instead of four, and the erasure pipeline already
  distinguishes ZDR-reliant (zero-data-retention) gateway providers from
  others (`docs/security/data-subject-request-runbook.md`, "Sub-processor
  propagation").
- No payment/card data ever enters this pipeline (see the RoPA billing row).
- Onprem operators can eliminate third-party transfer entirely by running
  Ollama locally; Azure OpenAI/LM Studio remain operator-configured
  alternatives for cases requiring a specific vendor relationship (e.g.
  existing BAAs).

## 3. Risk assessment

| # | Risk | Current mitigation | Residual risk |
|---|---|---|---|
| R1 | Compromised or malicious AI provider/subprocessor exposes in-flight or logged prompt content | Single-funnel OpenRouter reduces subprocessor surface vs. direct multi-vendor integration; ZDR-reliant providers preferred where available (`data-subject-request-runbook.md`) | Medium — depends on OpenRouter and downstream vendor security posture, outside our direct control |
| R2 | `chat_messages.content`/`pages.content` are stored **plaintext** in our own database, with no encryption-at-rest scheme — this is explicitly scoped out of the field-encryption epic (not "in progress"), because the existing substring search (`ilike(pages.content, ...)`) has no working encrypted equivalent (`docs/security/pii-encryption-design.md`, "Why content is scoped OUT") | Access to content is gated by `packages/lib/src/permissions/` (message/page visibility checks); all reads/writes/exports are logged to `security_audit_log` | Medium-High — a database compromise exposes this content in the clear; mitigation is access-control depth, not encryption, until a searchable-encryption design ships |
| R3 | Cross-border transfer: OpenRouter forwards content to underlying vendors (potentially outside the EEA) | ZDR-reliant provider preference; erasure pipeline tracks per-provider retention behavior | `[TODO: confirm OpenRouter and underlying-vendor DPA/SCC coverage — legal follow-up]` |
| R4 | Onprem Azure OpenAI region misconfiguration could route EU data subjects' content outside the EEA — today there is zero region enforcement or guidance (`.env.onprem.example`, `provider-factory.ts` + `validateLocalProviderURL` perform only SSRF checks, no region awareness) | New onprem guidance doc recommends an EU-region Azure OpenAI resource for EU-serving deployments (see [`gdpr-onprem-ai-region-guidance.md`](gdpr-onprem-ai-region-guidance.md)) | Medium, pending `[TODO: confirm whether region should be enforced in config validation or left as operator guidance]` in that doc |
| R5 | Users may inadvertently include third-party personal data in prompts, which then flows to the AI provider and is persisted | No content-level PII redaction exists; relies on user judgment and access control on the stored conversation | Low-Medium — inherent to any free-text AI product; not specific to this codebase |
| R6 | Unauthorized access to stored chat/page history (insider or compromised-account access) | `packages/lib/src/permissions/` centralizes all message/page visibility checks; `security_audit_log` records data.read/write/export events with tamper-evident hash chaining (`packages/lib/src/audit/security-audit.ts`) | Low, contingent on permission-check coverage remaining complete as features are added |

## 4. Mitigations already in place

- **Access control** — `packages/lib/src/permissions/` is the single, centralized
  gate for message/page visibility (`canUserViewPage`, `getUserAccessLevel`,
  etc.); no scattered ad-hoc permission checks were found guarding this data.
- **Audit trail** — `security-audit.ts` logs `data.read`/`data.write`/`data.export`
  events with a tamper-evident hash chain, plus AES-256-GCM IP encryption
  (conditional on `ENCRYPTION_KEY`).
- **Erasure propagation** — the Right-to-Erasure pipeline builds a per-provider
  manifest and records ZDR-reliant vs. skipped vs. `manual_review` status per
  AI provider actually invoked by the subject
  (`docs/security/data-subject-request-runbook.md`).
- **Breach response** — if an AI provider or subprocessor is compromised, the
  Art 33/34 notification lifecycle in `docs/security/breach-runbook.md`
  applies.
- **Pseudonymization escape hatch** — if a supervisory authority disputes
  retained audit-log rows referencing AI-related events,
  `docs/security/gdpr-pseudonymization-runbook.md` provides the operational
  path.
- **In progress** — onprem EU-region guidance for Azure OpenAI
  ([`gdpr-onprem-ai-region-guidance.md`](gdpr-onprem-ai-region-guidance.md))
  directly reduces R4.

## 5. Residual risk conclusion

The two live residual risks are (a) plaintext storage of chat/page content in
our own database, pending a searchable-encryption design that doesn't yet
exist, and (b) third-party subprocessor transfer via OpenRouter to vendors
whose DPA/SCC coverage has not been confirmed by legal. Both are bounded today
by centralized access control, a tamper-evident audit trail, and an erasure
pipeline that already accounts for provider-specific data-retention behavior —
but a DPIA is not complete without a named, accountable sign-off on whether
this residual risk level is acceptable.

[TODO: risk-owner sign-off — name + date]
