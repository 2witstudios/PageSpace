# GDPR Full Audit

## WHY

PageSpace operates as SaaS at pagespace.ai with EU users in scope for GDPR. It also
ships in `onprem` and `tenant` deployment modes that each have different compliance
postures. We need a comprehensive, article-grounded audit that turns into a concrete
remediation backlog — not a generic "are we GDPR compliant?" checkbox.

A prior compliance survey exists at `docs/security/compliance-sovereignty-analysis.md`
— it focuses on data sovereignty and hard incompatibilities. **This audit is narrower
and deeper**: GDPR articles only, every finding mapped to an article and a file path.

All streams must treat the three deployment modes separately where behavior diverges:
- **`cloud`** — pagespace.ai SaaS, Stripe, OAuth, cloud AI providers, self-registration
- **`onprem`** — self-hosted, no Stripe/OAuth, admin-managed accounts, local AI
- **`tenant`** — managed multi-tenant, billing at control-plane, business-tier features

See `packages/lib/src/deployment-mode.ts` for the canonical mode detection.

## OUTPUT FORMAT (every stream must follow)

Each stream writes ONE markdown file at `docs/security/gdpr-audit/<NN-slug>.md`.

Structure:

```md
# Stream N: <Title>

## Summary
<3-5 bullet headline findings>

## Findings

### F<N>.<seq> — <short title>
- **GDPR article(s):** Art X(Y)
- **Severity:** critical | high | medium | low | informational
- **Deployment modes affected:** cloud | onprem | tenant | all
- **Location:** `path/to/file.ts:LINE` (one or more)
- **Current behavior:** <what the code does today, verified by reading>
- **Gap:** <why this fails the article, citing the specific obligation>
- **Recommendation:** <concrete remediation, not hand-wavy>
- **Effort:** S | M | L

### F<N>.<seq+1> — ...
```

End every doc with a **Checklist of what was examined** section — list every file
path inspected, so reviewers can verify coverage.

## RULES FOR ALL AGENTS

1. **Read-only audit.** Do NOT modify source code. You may only create your findings
   doc under `docs/security/gdpr-audit/`. If you believe a fix is urgent, record it as
   a finding — do not implement it.
2. **Ground every finding in a GDPR article.** Art 5, 6, 7, 12-22 (rights), 24-30
   (controller/processor), 32 (security), 33-34 (breach), 35 (DPIA), 44-49 (transfers).
   No article = not a finding (put it in an "observations" appendix).
3. **Cite file paths + line numbers.** Every finding must be verifiable by `grep`.
4. **Consider all three deployment modes.** Mark each finding with which modes it
   applies to. A finding that only affects `cloud` should say so explicitly.
5. **Do not duplicate the sovereignty analysis doc.** If the existing doc already
   covers something at the right depth, reference it by section and move on. Your job
   is to surface NEW or more specific findings.
6. **No scope reduction.** Every file in your stream's purview must be examined. If
   context fills up, record partial findings and create a continuation note — never
   shrink scope silently.
7. **Use plan mode.** Research first, write findings second. No speculative code.
8. **Respect in-flight work.** There is a running agent on branch
   `pu/audit-pii-masking` covering PII in audit logs. Stream 4 must NOT re-audit
   the same surface — read that branch's diff, reference its scope, and cover
   everything else.

## STREAMS

### Stream 1 — Data Subject Rights + Retention + Erasure
Output: `docs/security/gdpr-audit/01-dsr-retention.md`

GDPR articles in scope: Art 15 (access), 16 (rectification), 17 (erasure), 18
(restriction), 20 (portability), 21 (objection), 5(1)(e) (storage limitation).

Required coverage:
- `apps/web/src/app/api/account/export/` + `apps/web/src/app/api/account/` (self-service)
- `apps/web/src/app/api/admin/users/[userId]/export/` + `/data/` (admin on behalf of user)
- `apps/web/src/app/api/activities/export/`
- `apps/web/src/app/api/drives/[driveId]/integrations/audit/export/`
- `apps/web/src/app/api/cron/retention-cleanup/` + `/cron/purge-ai-usage-logs/`
- Account deletion: cascade completeness across `packages/db/src/schema/*.ts` —
  pages, drives, chats, AI messages, files, sessions, integrations, passkeys,
  subscriptions, audit logs, activity logs, versions, page-views, notifications,
  hotkeys, personalization, dashboard, calendar, push-notifications, tasks,
  workflows, members, permissions, feedback, social, contact, email-notifications.
- File storage erasure on disk (not just DB rows) — `apps/processor/` worker paths.
- AI chat message erasure — `packages/db/src/schema/chat.ts` + `ai.ts`.
- Vector / search index erasure (if any) — grep for embeddings, pgvector, search indexes.
- Audit log retention windows — are audit logs themselves excluded from erasure under
  Art 17(3)(b) legal-obligation exemption? If so, is that documented?
- Version history: does `packages/db/src/schema/versioning.ts` hold deleted content?
- Backups: how does restore-from-backup interact with erasure requests?
- Soft vs hard deletes — grep for `deletedAt`, `isDeleted`, and assess whether
  soft-deleted rows eventually hard-delete.
- Export completeness: does the export contain EVERY category of personal data the
  controller holds on the subject? Compare export payload vs schema inventory.
- Export format — Art 20 requires "structured, commonly used and machine-readable".

Specific questions to answer:
- Can a user request erasure and have it completed within 30 days without manual admin
  action? If not, that's a finding.
- Are third-party processors (AI providers, Stripe) notified of erasure requests per
  Art 17(2)?
- Does admin/users/[userId]/export reach the same completeness as account/export?

### Stream 2 — Consent, Lawful Basis, Legal Pages
Output: `docs/security/gdpr-audit/02-consent-legal.md`

GDPR articles in scope: Art 6 (lawful basis), 7 (consent conditions), 8 (minors),
9 (special categories), 12-14 (information to data subjects), 22 (automated decisions),
25 (privacy by design), 35 (DPIA threshold).

Required coverage:
- Signup flows: `apps/web/src/app/auth/**`, `apps/web/src/app/api/auth/**`
- Marketing site: `apps/marketing/**` — privacy policy, ToS, cookie policy pages
- Cookie banner / consent management — grep for `cookie`, `consent`, `tracking`
- AI processing consent — are users informed that prompts leave the EU and go to
  Anthropic/OpenAI/Google/xAI? Per-workspace opt-in? Per-provider?
- Stripe checkout + billing — `apps/web/src/app/api/stripe/**` — lawful basis is
  contract, but Art 13 notice requirements still apply
- Google OAuth / One Tap — consent scope, data minimization
- Marketing emails — `packages/db/src/schema/email-notifications.ts` — opt-in vs
  opt-out, unsubscribe flow, `packages/lib/src/services/` for email services
- Age verification — is there any? Art 8 requires parental consent for under-16 in
  many member states.
- Automated decision-making — Art 22 — does AI chat/search produce decisions with
  legal effect? (Probably not, but document the position.)
- DPIA requirement — has a DPIA been performed? If not, note the obligation.
- DPO contact — Art 37 — is there a DPO? Contact surface?
- Records of processing (Art 30) — does a register exist? Where?
- Legal basis per processing purpose — produce a table mapping each processing
  purpose to a legal basis (consent / contract / legitimate interest / legal
  obligation / vital interest / public task).

### Stream 3 — Processors + Cross-Border Transfers
Output: `docs/security/gdpr-audit/03-processors-transfers.md`

GDPR articles in scope: Art 28 (processor), 29 (processor instructions), 30
(records), 44-49 (transfers), 46 (SCCs), 49 (derogations).

Required coverage:
- Full subprocessor inventory from the codebase. Grep for every external service:
  - Anthropic, OpenAI, Google AI, xAI, OpenRouter, Ollama — `apps/web/src/lib/ai/**`
  - Stripe — `apps/web/src/app/api/stripe/**`, control-plane `apps/control-plane/**`
  - Resend / transactional email — `packages/lib/src/services/**`
  - Google OAuth + Calendar — `packages/lib/src/integrations/**`
  - GitHub integration — `packages/lib/src/integrations/**`
  - Sentry / error reporting / telemetry — grep for `sentry`, `posthog`, `analytics`
  - SIEM / audit log shipping — `packages/lib/src/audit/**`
  - Any CDN, image processing, OCR services — `apps/processor/**`
- For EACH processor:
  - Art 28 contract in place? (DPA link or note "unknown")
  - Cross-border transfer mechanism: SCCs? Adequacy decision? Derogation?
  - Subprocessor list maintained?
  - Data categories sent to that processor
  - Retention at the processor
- Deployment-mode differences:
  - `onprem` disables Stripe/OAuth/self-registration — confirm in code
  - `tenant` uses control-plane billing — map control-plane's processor surface
  - `cloud` full surface
- AI provider data-flow per model — does PageSpace route EU user data only to EU
  endpoints for any provider? (Probably not — document it.)
- Data residency: where does Postgres live? Where do files live? Where do backups live?
  Check `apps/web/src/lib/storage/**`, processor paths, and deploy repo references.
- Non-EU operator access — who at 2witstudios can SSH into prod, access DB, read
  content? Art 32 + Art 28 sub-issue.

### Stream 4 — Data Minimization + Security + Breach
Output: `docs/security/gdpr-audit/04-minimization-breach.md`

GDPR articles in scope: Art 5(1)(c) minimization, Art 5(1)(d) accuracy, Art 25
(privacy by design/default), Art 32 (security), Art 33-34 (breach notification).

**Coordinate with in-flight `pu/audit-pii-masking` branch** — read its scope and
EXCLUDE anything it already covers from deep inspection. Do cover adjacent surfaces.

Required coverage:
- PII in non-audit logs: grep `console.log`, `logger.info`, error messages. Any
  user content, emails, tokens, IP addresses logged at info/debug?
- Search index PII leakage — `apps/web/src/app/api/search/**`, especially the
  existing `gdpr-audit-compliance.test.ts` — what does that test actually enforce?
- Realtime channel payloads — `apps/realtime/src/**` — is authz tight enough that
  users only see data they're permitted to?
- File processing — `apps/processor/**` — does OCR/extraction store derivatives
  beyond what's needed?
- AI chat history — how long is it kept? Are user prompts ever sent to analytics?
- Error reporting — if Sentry is wired up, is PII scrubbed? If not, finding.
- Encryption at rest — Postgres disk encryption? File storage encryption?
  Password hashing (bcryptjs — verify cost factor). Session tokens — SHA-256
  hashed per CLAUDE.md, verify in `packages/lib/src/auth/**`.
- Encryption in transit — TLS termination (Caddy per CLAUDE.md), HSTS, cert pinning
  for mobile apps
- Secret handling — env vars, rotated? Committed secrets? Grep `.env`, `process.env`
- Breach detection — is there monitoring that would flag a breach within 72h?
  Check `packages/lib/src/monitoring/**`.
- Breach notification pipeline — Art 33 requires notifying supervisory authority
  within 72h, Art 34 notifying data subjects "without undue delay" for high-risk
  breaches. Is there even a plan? Template email? Runbook?
- Hash-chain audit integrity — `packages/lib/src/monitoring/hash-chain-verifier.ts`
  — does this actually protect tamper-evidence for GDPR-relevant events?
- Records of processing integration — does the security-audit schema double as an
  Art 30 record? Or just as access audit?

## DELIVERABLE

After all 4 streams complete, a synthesizer agent will produce
`docs/security/gdpr-audit/MASTER_REPORT.md` containing:
- Executive summary (1 page)
- All findings deduplicated, sorted by severity then article
- Remediation backlog ordered by (severity, effort) with suggested epic names
- GDPR article coverage matrix: article → finding IDs
- Deployment-mode matrix: mode → finding IDs
- Next steps for stakeholders (legal, eng, ops)
