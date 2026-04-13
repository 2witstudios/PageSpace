# Stream 3: Processors + Cross-Border Transfers

> **Audit date:** 2026-04-12
> **Branch:** `pu/gdpr-processors`
> **Scope:** GDPR Art 28 (processor), Art 29 (instructions), Art 30 (records), Art 44-49 (transfers).
> **Deployment modes covered:** cloud, onprem, tenant.
> **Companion stream 4 in-flight:** `pu/audit-pii-masking` (PII in audit logs) — not re-audited here.
> **Prior related work:** `docs/security/compliance-sovereignty-analysis.md` — referenced where it already covers a topic at the right depth; this audit narrows to GDPR articles and adds new findings.

---

## Summary

1. **No Art 28 DPA inventory exists anywhere in the repo, deploy repo, or legal pages.** The only strings matching `DPA` / `subprocessor` / `Standard Contractual` live in `compliance-sovereignty-analysis.md` — an internal analysis doc, not a processor register. [F3.9, F3.10, F3.11]
2. **PageSpace's default AI tier routes prompts to Z.AI (China) with no adequacy decision, no SCCs, and no disclosure on the privacy page.** `PAGESPACE_MODEL_ALIASES = { standard: 'glm-4.7', pro: 'glm-5' }` — both resolve to GLM on `https://api.z.ai`. The marketing privacy page's §4 AI-provider list omits Z.AI entirely. [F3.1, F3.23]
3. **Tenant mode does not filter cloud AI providers.** `getVisibleProviders()` only strips providers when `DEPLOYMENT_MODE === 'onprem'`, so tenant-mode customers surface MiniMax, Z.AI, xAI, and the full BYOK cloud stack with no privacy-by-default gating. [F3.24]
4. **US processing is declared but no Art 46 transfer mechanism is named.** `apps/marketing/src/app/privacy/page.tsx:192-198` states servers are in the United States. Post-Schrems II, transfer of EU personal data to a US controller needs SCCs, DPF enrollment, or BCRs — none are referenced. [F3.15]
5. **Resend email is not deployment-mode gated.** `packages/lib/src/services/email-service.ts` performs zero mode checks; an onprem operator that sets `RESEND_API_KEY` silently begins shipping subject emails to Resend's US infrastructure with no DPA. [F3.4]

---

## Processor Inventory

Every row is one processor. `?` = cannot be determined from code/repo alone and must be confirmed by legal / procurement.

| # | Processor | Data Categories | Art 28 DPA (link or unknown) | Transfer Mechanism (SCC / Adequacy / Derogation / none) | Subprocessors | Retention | Deployment Modes |
|---|---|---|---|---|---|---|---|
| 1 | **Z.AI / GLM** (PageSpace default tier) | Full prompt, system prompt, chat history, `userId`, drive names, breadcrumbs, page title & path, tool results, vision/images | unknown (no reference in repo) | **none documented**; no adequacy decision for China; no SCC citation | ? | ? (provider-side) | cloud, tenant |
| 2 | **Anthropic (Claude)** | as above | unknown | **none documented** — Anthropic publishes SCCs + DPA but none cited in code/docs; Anthropic EU endpoint exists but is not wired | ? | provider-side | cloud, tenant (BYOK) |
| 3 | **OpenAI (chat + Whisper audio)** | Prompts, history, audio blobs up to 25 MB (`apps/web/src/app/api/voice/transcribe/route.ts`) | unknown | **none documented**; OpenAI publishes DPA + SCCs, not cited | ? | provider-side | cloud, tenant (BYOK) |
| 4 | **Google Generative AI (Gemini)** | as row 2 | unknown | **none documented**; Google Cloud SCCs exist, not cited; Vertex regions not used | ? | provider-side | cloud, tenant (BYOK) |
| 5 | **xAI (Grok)** | as row 2 | unknown | **none documented**; not listed on marketing privacy page §4 | ? | provider-side | cloud, tenant (BYOK) |
| 6 | **OpenRouter** | as row 2 (then cascades to a second-hop provider) | unknown | **none documented**; OpenRouter is itself a proxy → adds second subprocessor hop with unknown chain | cascades (unknown per call) | provider-side | cloud, tenant (BYOK) |
| 7 | **MiniMax** | as row 2 | unknown | **none documented**; China — no adequacy | ? | provider-side | cloud, tenant (BYOK) |
| 8 | **Azure OpenAI** | as row 2 | unknown | user-chooses region (EU possible); mechanism still **not documented** | ? | provider-side | onprem only (in `ONPREM_ALLOWED_PROVIDERS`) |
| 9 | **Ollama / LM Studio** | as row 2 but local | N/A (on-device / same network) | **transfer does not occur** if the node is in-region | N/A | N/A | onprem (allowed set); cloud+tenant technically visible but rarely configured |
| 10 | **Stripe** | Email, name, `userId`, billing address, payment method, subscription status (`apps/web/src/lib/stripe-customer.ts:49-53`); webhook inbound carries same | unknown (Stripe publishes DPA; not cited in repo) | SCC-eligible (Stripe publishes); **not cited** | Stripe subprocessors (unknown chain) | provider-side; we store `stripeCustomerId` on `users` indefinitely | cloud (direct), tenant (via control-plane — `apps/control-plane/src/routes/stripe-webhooks.ts`) |
| 11 | **Resend** | Recipient email, subject, rendered React email body (verification + magic-link tokens, feedback notifications) | unknown | **none documented**; Resend is US-based | ? | provider-side | cloud; **leak risk** in onprem/tenant because there is no mode check (F3.4) |
| 12 | **Google OAuth + One Tap** | Google `sub`, email, name, picture, `email_verified` (`packages/lib/src/auth/oauth-utils.ts:20-72`) | unknown | **none documented**; Google OAuth terms cover it but not cited | ? | we store tokens encrypted | cloud only (CSP-gated via `IS_CLOUD` in `apps/web/src/middleware/security-headers.ts:45,58-68`) |
| 13 | **Google Calendar API** | OAuth tokens, calendar events, attendees, times, descriptions (scope `https://www.googleapis.com/auth/calendar`) | unknown | **none documented** | ? | our side: `googleCalendarConnections` rows persist beyond `status=REVOKED` (see F3.19) | cloud; **not mode-gated** at route level (F3.20) — routes under `apps/web/src/app/api/integrations/google-calendar/**` have no deployment-mode checks |
| 14 | **GitHub (OAuth integration)** | Access token (encrypted via `encryptCredentials`), repo contents (inc. private via `repo` scope), issues, PRs, code | unknown | **none documented** | GitHub subprocessors (unknown chain) | our side: encrypted integration credential rows | cloud; **not mode-gated** (F3.20) |
| 15 | **Apple APNs** | Device token, notification title, body, arbitrary `payload.data` (`packages/lib/src/notifications/push-notifications.ts:135-147`) | unknown | **none documented** — APNs is Apple US infrastructure | ? | provider-side (delivery window) | cloud, tenant, onprem (mobile apps independent of web deployment mode) |
| 16 | **Let's Encrypt (ACME CA)** | Domain names, ACME challenge tokens (`PageSpace-Deploy/Caddyfile` — default ACME) | N/A (public CA, not a personal-data processor) | N/A | N/A | N/A | all |
| 17 | **Hosting VPS provider** | All of it (Postgres, Redis, files) | unknown — provider identity **not documented in the deploy repo** | unknown | unknown | persistent | all |
| 18 | **External OCR (Google AI)** — opt-in via `ENABLE_EXTERNAL_OCR=true` | Image bytes → extracted document text → stored in local cache and shipped to Google AI vision model (`apps/processor/src/workers/ocr-processor.ts:56-62`) | unknown | **none documented**; no additional consent UX | as Google AI row | as Google AI row | all modes where flag is set; default is `false` |

---

## Deployment-mode matrix

| Processor | cloud | onprem | tenant |
|---|---|---|---|
| Z.AI GLM (default) | ✓ | ✗ (`getVisibleProviders` drops all non-`ONPREM_ALLOWED_PROVIDERS`) | **✓ (NOT filtered — F3.24)** |
| Anthropic / OpenAI / Google / xAI | ✓ | ✗ | **✓ (NOT filtered)** |
| OpenRouter | ✓ | ✗ | **✓ (NOT filtered)** |
| MiniMax | ✓ | ✗ | **✓ (NOT filtered)** |
| Ollama / LM Studio | visible | ✓ (allowed set) | visible |
| Azure OpenAI | ✗ (not in `ONPREM_ALLOWED_PROVIDERS`, but client also won't surface it cleanly) | ✓ (allowed set) | ? |
| Stripe (web app) | ✓ | ✗ (no secret configured) | ✗ (handled by control-plane) |
| Stripe (control-plane) | ✗ | ✗ | ✓ |
| Resend | ✓ | **leak risk (F3.4)** — no code-level gating | **leak risk (F3.4)** |
| Google OAuth / One Tap | ✓ | ✗ (CSP-gated by `IS_CLOUD`) | ✗ (CSP-gated) |
| Google Calendar (backend routes) | ✓ | ? (**not mode-gated** at route level — F3.20) | ? (not gated) |
| GitHub integration (backend routes) | ✓ | ? (**not gated**) | ? |
| Apple APNs | ✓ (if mobile clients register) | ✓ (mobile clients register independently) | ✓ |
| Control plane | ✗ | ✗ | ✓ |
| External OCR → Google AI | opt-in | opt-in | opt-in |
| VPS + backups | ✓ | ✓ | ✓ |

---

## Findings

### F3.1 — Default AI tier routes prompts to Z.AI (China) with no Art 46 mechanism
- **GDPR article(s):** Art 44, Art 46, Art 5(1)(a) (lawfulness/transparency)
- **Severity:** critical
- **Deployment modes affected:** cloud, tenant
- **Location:**
  - `apps/web/src/lib/ai/core/ai-providers-config.ts:11-14` — `PAGESPACE_MODEL_ALIASES = { standard: 'glm-4.7', pro: 'glm-5' }`
  - `apps/web/src/lib/ai/core/ai-providers-config.ts:51-57,370-378` — GLM model catalog
  - `apps/web/src/lib/ai/core/provider-factory.ts:400-422` — `glm_coder_plan` provider wiring
  - Endpoint: `https://api.z.ai/api/coding/paas/v4`
- **Current behavior:** Every PageSpace subscriber on the default `standard` or `pro` alias has their prompts, system prompts, full chat history, tool definitions, and `experimental_context` (`userId`, drive names, page titles, breadcrumbs) sent to Z.AI in China. No fallback and no disclosure.
- **Gap:** China is not subject to an adequacy decision under Art 45. The repo contains no SCCs, no derogation analysis under Art 49, and no Art 46 safeguard of any kind. Every EU data subject using the default tier therefore has personal data transferred without a lawful basis for transfer.
- **Recommendation:** (a) At minimum, route EU users to a different default — Anthropic Claude (SCCs + DPF possible), Azure OpenAI in West Europe, or local Ollama. (b) Execute SCCs with Z.AI Inc. if routing to GLM is to continue and disclose the country of processing under Art 13(1)(f). (c) Introduce a per-region provider-default resolver that inspects the user's declared region.
- **Effort:** M (new resolver + procurement work + privacy-page rewrite)

### F3.2 — `userId` and workspace metadata leave PageSpace on every AI request (minimization + transfer)
- **GDPR article(s):** Art 5(1)(c) (data minimization), Art 28(3)(a) (written instructions), Art 44
- **Severity:** high
- **Deployment modes affected:** cloud, tenant
- **Location:** `apps/web/src/app/api/ai/chat/route.ts:874-889`
- **Current behavior:** Each `streamText` call sets `experimental_context: { userId, timezone, aiProvider, aiModel, conversationId, locationContext: { currentPage: { id, title, type, path }, currentDrive: { id, ... } } }`. System prompt at line 781 concatenates drive name, page title, and page path into the prompt body itself.
- **Gap:** `userId` is pseudonymous but persistent across every prompt — it enables the processor to correlate a user's entire interaction history. Drive names and breadcrumbs are organizational metadata that is not required for inference. This violates Art 5(1)(c) and, combined with F3.1, amplifies the transfer footprint. Prior sovereignty analysis §2.4 flagged this but proposed a fix that never landed.
- **Recommendation:** (a) Replace `userId` with a per-conversation ephemeral token scoped to the request. (b) Move organizational metadata (drive name, breadcrumbs) to tool-callable context rather than prompt injection, allowing users to opt out per request. (c) Add a server-side `stripSensitiveContext(provider)` helper that is called for every cloud provider.
- **Effort:** S-M

### F3.3 — Stripe transfers with no SCC / DPA reference in repo or legal pages
- **GDPR article(s):** Art 28(3), Art 44, Art 46
- **Severity:** high
- **Deployment modes affected:** cloud (web direct), tenant (via control-plane)
- **Location:**
  - `apps/web/src/lib/stripe-customer.ts:49-53` — `stripe.customers.create({ email, name, metadata: { userId } })`
  - `apps/web/src/app/api/stripe/webhook/route.ts` — inbound
  - `apps/control-plane/src/routes/stripe-webhooks.ts` — tenant mode
- **Current behavior:** Customer email, name, and internal user ID are sent to Stripe. Stripe webhooks deliver subscription lifecycle events back.
- **Gap:** Stripe does publish a DPA with SCCs and is DPF-enrolled, but nothing in this repo (code, privacy page, deploy repo, `docs/security/**`) references it. Art 28(3) requires the processor contract to be "in writing" and referenceable; Art 30 requires its existence to be recorded. Neither obligation is demonstrably met.
- **Recommendation:** (a) Commit a `docs/security/processors/stripe.md` note linking to the executed Stripe DPA and capturing signed date + contract URL. (b) Cite it from the marketing privacy page's §13 (Payment and Billing). (c) Add Stripe to the ROPA (see F3.11).
- **Effort:** S

### F3.4 — Resend email has no deployment-mode gating (cross-mode leak risk)
- **GDPR article(s):** Art 28, Art 44, Art 25 (privacy by design)
- **Severity:** high
- **Deployment modes affected:** cloud (active), onprem (silent-leak risk), tenant (silent-leak risk)
- **Location:** `packages/lib/src/services/email-service.ts` (60 lines total — entire file has zero `isCloud()` / `isOnPrem()` / `DEPLOYMENT_MODE` references)
- **Current behavior:** `sendEmail()` calls `resend.emails.send({ from, to, subject, react })`. If `RESEND_API_KEY` is set, emails go out. The module does not check deployment mode; `packages/lib/src/deployment-mode.ts:15-29` helpers are never imported.
- **Gap:** An onprem customer who copies the web app's `.env.example` without auditing may set `RESEND_API_KEY` and inadvertently activate a cross-border transfer to Resend's US infrastructure. Tenant mode has the same surface. There is no DPA reference anywhere in the repo and Resend subprocessors are not disclosed.
- **Recommendation:** (a) Make `sendEmail()` throw in onprem mode unless `ONPREM_ALLOW_RESEND=1` is explicitly set. (b) Introduce a pluggable `EmailTransport` interface so onprem can route via local SMTP (Postfix). (c) Commit a `docs/security/processors/resend.md` with the DPA reference.
- **Effort:** S (mode gate) + M (transport interface)

### F3.5 — Google OAuth / One Tap / Calendar: no DPA reference, Calendar scope is broad
- **GDPR article(s):** Art 28, Art 44, Art 46, Art 13(1)(e)
- **Severity:** medium
- **Deployment modes affected:** cloud (Calendar routes also reachable in onprem/tenant because not gated — see F3.20)
- **Location:**
  - `packages/lib/src/auth/oauth-utils.ts:20-72` — `verifyGoogleIdToken()`
  - `apps/web/src/app/api/integrations/google-calendar/callback/route.ts:20-50` — OAuth callback, token encryption
  - Scopes: `https://www.googleapis.com/auth/calendar` (read/write) + `userinfo.email`
- **Current behavior:** Tokens are encrypted at rest via `encrypt()` from `@pagespace/lib`. ID tokens provide `sub`, `email`, `name`, `picture`, `email_verified`.
- **Gap:** Google is covered by Google's own DPA + SCCs + DPF; neither is cited. Calendar scope is full read-write (`/auth/calendar`), not the narrower `calendar.events.readonly` — data minimization under Art 5(1)(c) is not demonstrated. No transfer mechanism is documented.
- **Recommendation:** (a) Narrow scope to `calendar.events.readonly` if only reads are needed. (b) Commit `docs/security/processors/google.md` with DPA reference. (c) Update privacy page to disclose Google OAuth/Calendar as a recipient under Art 13(1)(e).
- **Effort:** S

### F3.6 — GitHub integration transfer has no DPA reference; `repo` scope grants full private-repo access
- **GDPR article(s):** Art 28, Art 46, Art 5(1)(c)
- **Severity:** medium
- **Deployment modes affected:** cloud; possibly others (see F3.20)
- **Location:** `packages/lib/src/integrations/providers/github.ts:22` — `scopes: ['repo', 'read:user']`
- **Current behavior:** OAuth 2.0 flow requests `repo` (full private repo read/write) and `read:user`. Tokens are encrypted at rest via the generic `packages/lib/src/integrations/credentials/encrypt-credentials.ts` (AES-256-GCM). Agents can read file contents, issues, and PRs.
- **Gap:** `repo` is the broadest GitHub scope possible. If the product only needs reads for AI tools, `public_repo` or the read-only `repo:status` + `repo_deployment` narrower set should be used. No GitHub DPA reference; GitHub is covered by Microsoft's SCCs but not cited anywhere in the repo.
- **Recommendation:** (a) Narrow scope (may require GitHub App migration). (b) Commit `docs/security/processors/github.md` citing the Microsoft Product Terms / DPA. (c) Add mode gating (F3.20).
- **Effort:** M

### F3.7 — Apple APNs transfer carries notification title + body to US infrastructure
- **GDPR article(s):** Art 28, Art 44, Art 46
- **Severity:** medium
- **Deployment modes affected:** cloud, tenant, onprem (mobile clients register regardless of web deployment mode)
- **Location:** `packages/lib/src/notifications/push-notifications.ts:121-147`
  - Line 128-130: `apnsHost = isProduction ? 'api.push.apple.com' : 'api.sandbox.push.apple.com'`
  - Line 135-147: payload contains `aps.alert.title`, `aps.alert.body`, plus arbitrary `...payload.data` spread
- **Current behavior:** Title and body strings are forwarded unscrubbed to Apple's US endpoint. Device token is the recipient identifier.
- **Gap:** No Apple Push Notification DPA reference. No scrubbing of potentially-sensitive content (e.g. a notification like "New comment on page 'Salary review 2026'" ships title text to Apple). No subprocessor disclosure.
- **Recommendation:** (a) Keep notification titles intentionally generic (e.g. "New activity in your workspace"). (b) Commit `docs/security/processors/apple.md`. (c) If high-sensitivity workspaces exist, provide a workspace-level setting to suppress content in push bodies.
- **Effort:** S

### F3.8 — External OCR opt-in silently ships extracted document text to Google AI
- **GDPR article(s):** Art 13, Art 44, Art 25
- **Severity:** medium
- **Deployment modes affected:** all (behavior identical across modes once flag is set)
- **Location:** `apps/processor/src/workers/ocr-processor.ts:56-62`
  - Line 56: `if (provider === 'tesseract' || !process.env.ENABLE_EXTERNAL_OCR)`
  - Line 59-62: falls through to `performAIVisionOCR(contentHash)` via `GOOGLE_AI_DEFAULT_API_KEY`
- **Current behavior:** Default is local Tesseract. Setting `ENABLE_EXTERNAL_OCR=true` silently routes the raw image bytes (and by extension extracted text) to Google AI's vision model, with no additional consent UX and no disclosure on the privacy page.
- **Gap:** Flipping an env var should not change the GDPR recipient list without a user-facing flow. Art 13(1)(e) requires data subjects to be informed of recipients.
- **Recommendation:** (a) Gate `ENABLE_EXTERNAL_OCR` behind a per-tenant admin setting with an explicit disclosure. (b) Log which documents were OCR'd externally so a DSAR export can surface this processor. (c) Add Google Vision API as a separate row in ROPA.
- **Effort:** S

### F3.9 — No Art 28(3) DPA inventory exists in repo, deploy repo, or legal pages
- **GDPR article(s):** Art 28(3), Art 28(1), Art 30(2)
- **Severity:** critical
- **Deployment modes affected:** all cloud-touching modes (cloud, tenant)
- **Location (absence):** grep across the entire worktree + `/Users/jono/production/PageSpace-Deploy/` for `Data Processing Agreement|Standard Contractual|subprocessor|\bDPA\b|\bSCCs?\b` returns only hits inside `docs/security/compliance-sovereignty-analysis.md` (5 lines, all internal commentary). There is no `docs/security/processors/`, `docs/legal/dpas/`, or equivalent directory. The marketing privacy page contains no subprocessor section.
- **Current behavior:** PageSpace relies on processors (Stripe, Resend, Google, Anthropic, OpenAI, Z.AI, MiniMax, xAI, OpenRouter, Apple, Microsoft/GitHub) without any committed artefact proving Art 28(3) written-contract obligations are met.
- **Gap:** Art 28(1) requires controllers to use only processors providing "sufficient guarantees". Art 28(3) requires the processing to be governed by a written contract. Without a DPA register, PageSpace cannot demonstrate either to a supervisory authority.
- **Recommendation:** Create `docs/security/processors/` with one markdown per processor citing (a) the signed DPA URL / version / date, (b) transfer mechanism (SCCs, DPF, BCR, derogation), (c) subprocessor list URL, (d) data categories, (e) retention. Make `CONTRIBUTING.md` reject PRs that add new external SDK imports without adding a processor entry.
- **Effort:** M (one-time procurement sweep + template)

### F3.10 — No subprocessor disclosure list or change-notification mechanism
- **GDPR article(s):** Art 28(2)(a), Art 28(4), Art 13(1)(e)
- **Severity:** high
- **Deployment modes affected:** cloud, tenant
- **Location (absence):**
  - `apps/marketing/src/app/privacy/page.tsx:114-126` (§6 Data Sharing) — says "service providers… under strict confidentiality agreements" but lists none.
  - `apps/marketing/src/app/privacy/page.tsx:69-82` (§4) — lists 4 AI providers, omits the default and 4 others (see F3.23).
  - No `/subprocessors` page, no RSS/email notification channel.
- **Current behavior:** Customers have no way to discover who we use or be notified of changes.
- **Gap:** Art 28(2)(a) requires controllers' prior written authorization of subprocessors (general or specific) and requires changes to be notified. Art 13(1)(e) requires disclosure of recipients.
- **Recommendation:** (a) Publish `https://pagespace.ai/subprocessors` with a full list + last-updated date. (b) Offer email subscription for changes. (c) Link from privacy page §6 and §4.
- **Effort:** S (content) once F3.9 provides the source of truth

### F3.11 — No Art 30 Records of Processing Activities (ROPA)
- **GDPR article(s):** Art 30(1), Art 30(2)
- **Severity:** high
- **Deployment modes affected:** all
- **Location (absence):** No `docs/security/ropa.md`, `docs/privacy/ropa.md`, or equivalent. The closest artefacts are `packages/lib/src/audit/security-audit.ts` (event log — not ROPA) and `docs/security/compliance-sovereignty-analysis.md` (analysis — not ROPA).
- **Current behavior:** There is no register of processing activities mapping purpose → lawful basis → data categories → recipients → retention → transfer mechanism.
- **Gap:** Art 30 requires controllers to maintain a ROPA. This is a hard documentary requirement, not a design one.
- **Recommendation:** Draft a ROPA for cloud mode, onprem mode, and tenant mode. Use the processor inventory in this audit as the "recipients" column. Bind it to CI so adding a new processor forces a ROPA update.
- **Effort:** M

### F3.12 — BYOK ambiguity: PageSpace still handles plaintext prompts even when the user provides the key
- **GDPR article(s):** Art 28 (processor/controller boundary), Art 13(1)(a-f)
- **Severity:** medium
- **Deployment modes affected:** cloud, tenant
- **Location:**
  - `apps/web/src/lib/ai/core/provider-factory.ts:147-274` — each provider loads the per-user encrypted API key from `userAiSettings`
  - `packages/db/src/schema/monitoring.ts:144-207` — `ai_usage_logs` stores first 1000 chars of `prompt` and `completion` (`ai_usage_logs.prompt`/`.completion`)
- **Current behavior:** When a user brings their own Anthropic/OpenAI key, PageSpace still (a) decrypts the key, (b) constructs the HTTPS request server-side, (c) sees the plaintext prompt in transit, and (d) writes the first 1000 chars of prompt and completion to `ai_usage_logs`.
- **Gap:** The privacy page and product do not disclose that BYOK does not exempt PageSpace from being a processor of that data — the user is not just "sending their own data to Anthropic", they are sending it through PageSpace first. This muddies Art 13(1)(a) identification and Art 28 processor duties. The secondary `ai_usage_logs` store creates a second personal-data copy independent of the provider (see F3.17).
- **Recommendation:** (a) Update the privacy page to make the BYOK data flow explicit. (b) Add a per-user toggle to disable `ai_usage_logs.prompt`/`.completion` capture. (c) Document that PageSpace is a processor for BYOK flows too.
- **Effort:** S (disclosure) + S (toggle)

### F3.13 — No documented processor breach-notification pipeline
- **GDPR article(s):** Art 28(3)(f), Art 33(2)
- **Severity:** high
- **Deployment modes affected:** all
- **Location (absence):** No runbook at `docs/security/runbooks/breach-notification.md` or equivalent. `packages/lib/src/audit/security-audit.ts` is tamper-evident logging, not breach response. Stream 4 covers inbound breach detection; stream 3 flags the processor-side notification chain specifically.
- **Current behavior:** If Stripe, Resend, Google, Anthropic, or any other processor notifies us of a breach, there is no documented pathway for that notice to reach an engineer, be logged, be forwarded to affected controllers (for tenant-mode), or trigger a 72-hour clock.
- **Gap:** Art 28(3)(f) requires processors to notify controllers "without undue delay" after becoming aware of a breach; by extension we need a receiving pipeline when we act as controller, and a forwarding pipeline when we act as processor for tenant-mode customers. Art 33(2) is our 72h obligation to the supervisory authority.
- **Recommendation:** (a) Publish a security contact email (e.g. `security@pagespace.ai`) and wire it to the on-call rota. (b) Draft `docs/security/runbooks/breach-notification.md` covering both inbound (processor → us) and outbound (us → controllers + supervisory authority). (c) For tenant mode, add a control-plane event type `processor.breach.reported`.
- **Effort:** M

### F3.14 — Unrestricted operator access to prod VPS; admin DSAR reads not separately audit-logged
- **GDPR article(s):** Art 28(3)(b) (confidentiality of persons authorised to process), Art 32(1)(b), Art 32(4)
- **Severity:** high
- **Deployment modes affected:** all
- **Location:**
  - `/Users/jono/production/PageSpace-Deploy/DEPLOY.md:109-117` — examples show `docker compose exec postgres psql …` assuming shell-level root access; no RBAC / bastion / break-glass model.
  - `apps/web/src/app/api/admin/users/[userId]/export/**` — admin DSAR route (confirmed to exist under `apps/web/src/app/api/admin/**` per stream 1 scope) has `withAdminAuth` but no distinct audit event when an admin reads another user's personal data.
- **Current behavior:** Any 2witstudios operator with SSH access to the VPS can `docker compose exec postgres psql -U pagespace -d pagespace_prod` and read every user's content. Admin DSAR endpoints log "admin accessed user" (per sovereignty doc §2.2), but there is no enforced separation of duties and no periodic review.
- **Gap:** Art 28(3)(b) requires the controller to ensure persons authorised to process personal data have committed themselves to confidentiality. Art 32 requires appropriate technical and organisational measures — for a processor of EU personal data, unreviewed shared root access is not appropriate. Art 32(4) requires any person acting under the controller's authority to process personal data only on instructions.
- **Recommendation:** (a) Document named operators + their access scopes in a SECURITY.md or internal register. (b) Require MFA at the VPS boundary. (c) Route all admin DSAR reads through a dedicated endpoint that emits a distinct `audit.admin.dsar.read` event with operator identity + subject identity + reason. (d) Periodic access review.
- **Effort:** M

### F3.15 — US processing declared but no Art 46 transfer mechanism named
- **GDPR article(s):** Art 44, Art 46, Art 13(1)(f)
- **Severity:** high
- **Deployment modes affected:** cloud, tenant (VPS location is shared)
- **Location:**
  - `apps/marketing/src/app/privacy/page.tsx:192-198` (§12) — "PageSpace is operated from the United States… your information may be transferred to, stored, and processed in the United States where our servers are located"
  - Absence: no SCC / DPF / BCR reference anywhere in the worktree or deploy repo; `PageSpace-Deploy/DEPLOY.md` does not name the hosting provider.
- **Current behavior:** PageSpace publicly declares US processing and asks users to "consent" to the transfer (§12 line 197-198).
- **Gap:** Post-Schrems II, the CJEU invalidated Privacy Shield and required Art 46 safeguards for EU→US transfers. Consent under Art 49(1)(a) is a derogation, not a substitute for Art 46, and can only be used for occasional transfers — not the continuous processing of all EU customer data. PageSpace must either (a) enrol under the EU-US Data Privacy Framework and cite the certification, (b) execute SCCs with itself as data importer and cite them, or (c) move EU-user data to an EU region.
- **Recommendation:** (a) Enrol the US entity under DPF and publish the certification on the privacy page. (b) Separately, document the hosting provider identity + region in the deploy repo. (c) Consider offering an EU region for EU customers.
- **Effort:** L (DPF enrolment) / M (SCC self-execution) / M (deploy doc) — pick one

### F3.16 — pg_dump backups are plaintext (not encrypted at rest)
- **GDPR article(s):** Art 32(1)(a)
- **Severity:** medium
- **Deployment modes affected:** all
- **Location:** `/Users/jono/production/PageSpace-Deploy/DEPLOY.md:113-117` — backup command is a plain `pg_dump > backup_<timestamp>.sql` with no GPG / openssl / age encryption, no destination pinning, and no retention policy.
- **Current behavior:** Backups sit on the VPS filesystem as plaintext SQL. A VPS compromise or a leaked snapshot exposes every row including chat content.
- **Gap:** Art 32(1)(a) lists "the pseudonymisation and encryption of personal data" as an example of appropriate technical measures. A plaintext backup that survives a disk snapshot is not appropriate for a service holding unencrypted page content.
- **Recommendation:** (a) Pipe `pg_dump` through `age` or GPG with a key held by a second operator. (b) Document retention (e.g. 14 days on-VPS + 90 days off-VPS). (c) Test restore quarterly.
- **Effort:** S

### F3.17 — `ai_usage_logs` creates a secondary personal-data store replicating first 1000 chars of prompts + responses
- **GDPR article(s):** Art 5(1)(c), Art 30(1)(c), Art 44
- **Severity:** medium
- **Deployment modes affected:** all
- **Location:** `packages/db/src/schema/monitoring.ts:144-207`
  - Line 176-177: `prompt: text('prompt'), // Store first 1000 chars` / `completion: text('completion'), // Store first 1000 chars`
  - Line 187: `expiresAt: timestamp('expires_at', { mode: 'date' })` — TTL column exists but no enforcement visible in the schema itself
- **Current behavior:** Every AI request writes a truncated copy of the user's prompt and the model's response to PostgreSQL, alongside `userId`, `conversationId`, `provider`, `model`. This is a second personal-data recipient (the PageSpace DB itself) on top of the provider side.
- **Gap:** Data minimization (Art 5(1)(c)) is weakened — we do not need prompt content for billing or observability. The residency of this store is whatever the VPS is; combined with F3.15, it compounds the US-processing concern for EU users. Prompt content should not be retained by default.
- **Recommendation:** (a) Default `prompt` and `completion` to `null`; only capture when a debug flag is set per-user. (b) Enforce `expiresAt` via a cron that hard-deletes expired rows (confirm `/api/cron/purge-ai-usage-logs` actually runs). (c) Document this store in the ROPA (F3.11).
- **Effort:** S

### F3.18 — Control plane holds tenant owner email + Stripe customer IDs for every tenant (tenant-mode specific processor surface)
- **GDPR article(s):** Art 28, Art 30
- **Severity:** medium
- **Deployment modes affected:** tenant
- **Location:**
  - `apps/control-plane/src/index.ts:82-92` — Stripe client
  - `apps/control-plane/src/routes/stripe-webhooks.ts` — tenant-scoped webhook handler
  - `apps/control-plane/src/routes/tenants.ts` — tenant provisioning (holds `tenant.slug`, `ownerEmail`, `tier`, Stripe customer/subscription IDs)
- **Current behavior:** Control plane is a separate process with its own PostgreSQL (`CONTROL_PLANE_DATABASE_URL`). It holds identifying personal data for every tenant owner.
- **Gap:** This second datastore is not mentioned in any ROPA (F3.11), the marketing privacy page does not reference it, and its relationship to the tenant customer (controller → processor) is not documented. For tenant-mode customers, we are a processor for their users AND a controller for their owner's billing — the dual role needs to be explicit.
- **Recommendation:** (a) Document control-plane in the ROPA as a distinct processing system. (b) Add a tenant-mode privacy notice (potentially separate from the consumer privacy page) explaining the dual role. (c) Encrypt `ownerEmail` at rest in the control-plane DB.
- **Effort:** M

### F3.19 — Google Calendar cached data + connection rows survive after disconnect
- **GDPR article(s):** Art 5(1)(e) (storage limitation), Art 17 (erasure)
- **Severity:** low
- **Deployment modes affected:** cloud
- **Location:** `apps/web/src/app/api/integrations/google-calendar/disconnect/route.ts` — marks `status='REVOKED'` and revokes token via Google; `googleCalendarConnections` row is **not deleted**, `syncCursor` / `selectedCalendars` / `lastSyncAt` persist.
- **Current behavior:** Disconnect revokes upstream but leaves historical sync metadata and any cached event rows in our DB.
- **Gap:** If a user disconnects and expects "all Calendar data gone", Art 17 is not satisfied in practice. Storage limitation (Art 5(1)(e)) is not demonstrated for the cache.
- **Recommendation:** (a) On disconnect, schedule a job to hard-delete `googleCalendarConnections` row + any cached event table after a short grace period (e.g. 7 days). (b) Make the grace period configurable. (c) Include calendar cache in DSAR export.
- **Effort:** S

### F3.20 — Google Calendar and GitHub integration routes are not deployment-mode gated
- **GDPR article(s):** Art 25 (privacy by design/default), Art 44
- **Severity:** medium
- **Deployment modes affected:** onprem, tenant (leak surface)
- **Location:**
  - Grep of `isOnPrem|isCloud|isTenantMode|DEPLOYMENT_MODE` against `apps/web/src/app/api/integrations/**` returns **zero matches**.
  - Contrast: `apps/web/src/middleware/security-headers.ts:45,58-68` does gate Google One Tap behind `IS_CLOUD`.
- **Current behavior:** A sysadmin can onprem-deploy PageSpace and still have Calendar and GitHub OAuth callback routes reachable — and active if the OAuth client IDs are configured.
- **Gap:** Art 25 requires privacy-by-default: onprem/tenant-mode users should not accidentally transfer data to Google / GitHub. F3.4 is the same pattern for Resend.
- **Recommendation:** Add `if (isOnPrem()) return 404;` at the top of each integration route that implies an external processor, unless an explicit opt-in env var is set.
- **Effort:** S

### F3.21 — Onprem-mode Azure OpenAI allows any region but docs give no guidance
- **GDPR article(s):** Art 46, Art 44
- **Severity:** low
- **Deployment modes affected:** onprem
- **Location:** `apps/web/src/lib/ai/core/provider-factory.ts:372-398` — Azure OpenAI provider accepts user-supplied `baseUrl` (encrypted)
- **Current behavior:** An onprem admin configures Azure OpenAI by entering a base URL; the app blindly accepts any region (`eastus`, `westeurope`, etc.).
- **Gap:** For an EU onprem customer, the whole point of choosing Azure over Anthropic is regional pinning — but no in-product guidance nudges them toward `westeurope` / `northeurope` / `germanywestcentral`.
- **Recommendation:** In the Azure OpenAI config UI, add a region guide with explicit EU recommendations and a validator that warns if a non-EU region is picked while `LOCALE=eu`.
- **Effort:** S

### F3.22 — Let's Encrypt CA / DNS edge relationships are not recorded as processors
- **GDPR article(s):** Art 30
- **Severity:** low
- **Deployment modes affected:** all
- **Location:** `/Users/jono/production/PageSpace-Deploy/Caddyfile` — ACME default (Let's Encrypt), no DNS provider or CDN documented
- **Current behavior:** Caddy auto-provisions TLS via Let's Encrypt; Let's Encrypt sees domain names and ACME challenge tokens but no user PII. DNS provider identity is unknown from the repo.
- **Gap:** While Let's Encrypt is not a personal-data processor, the ROPA (F3.11) should still record the TLS/DNS relationships and confirm that no CDN (Cloudflare, Fastly) is in the request path. An undocumented edge would be a blind spot.
- **Recommendation:** Record TLS/DNS relationships in the ROPA even if they don't touch personal data; explicitly confirm there is no reverse-proxy CDN in the path.
- **Effort:** S

### F3.23 — Marketing privacy page's AI-provider list omits the default provider and four others
- **GDPR article(s):** Art 13(1)(e), Art 14(1)(e)
- **Severity:** high
- **Deployment modes affected:** cloud (marketing site reflects cloud product)
- **Location:** `apps/marketing/src/app/privacy/page.tsx:69-82` (§4 Third-Party AI Services)
- **Current behavior:** §4 lists only **OpenRouter, Google AI, Anthropic, OpenAI**. It omits:
  - **Z.AI / GLM** — this is the *default* provider for `standard` and `pro` tiers per `ai-providers-config.ts:11-14`
  - **xAI (Grok)**
  - **MiniMax**
  - **Azure OpenAI** (onprem path but still a recipient category)
  - **Ollama / LM Studio** (less urgent — no transfer if local, but should still be noted as possible recipients)
- **Gap:** Art 13(1)(e) requires data subjects to be informed of recipients or categories of recipients at the time of collection. A default-tier user whose prompts go to Z.AI has no way of learning that from the privacy page. This is the most severe disclosure gap in the surface.
- **Recommendation:** Rewrite §4 to list **all** providers currently wired in `ai-providers-config.ts`, mark which is the default per tier, link to each provider's DPA, and make a note that the list is regenerated from the config file in CI.
- **Effort:** S (content) — but it must be kept in sync (add a CI check)

### F3.24 — Tenant mode inherits the full cloud AI provider set (no privacy-by-default filtering)
- **GDPR article(s):** Art 25, Art 24, Art 44
- **Severity:** high
- **Deployment modes affected:** tenant
- **Location:** `apps/web/src/lib/ai/core/ai-providers-config.ts:488-510`
  - Line 491: `ONPREM_ALLOWED_PROVIDERS = new Set(['ollama', 'lmstudio', 'azure_openai'])`
  - Line 498-510: `getVisibleProviders()` only applies the filter when `DEPLOYMENT_MODE === 'onprem'`
- **Current behavior:** Tenant mode (used by managed multi-tenant installations) does not filter providers at all. A tenant's end-users can select MiniMax, Z.AI, OpenRouter, xAI — the full cloud surface — with no restriction.
- **Gap:** Tenant mode is the *managed* deployment. Customers on tenant mode pay for a more controlled product than cloud self-service, and the product positioning ("business-tier features", "managed instance" — see `packages/lib/src/deployment-mode.ts:8-11`) implies tighter data handling. Art 25 requires privacy by default — the default set of providers should be the narrowest reasonable set.
- **Recommendation:** (a) Introduce `TENANT_ALLOWED_PROVIDERS` (or make the set configurable per tenant in the control plane). (b) Default tenant mode to a subset that excludes Z.AI + MiniMax + OpenRouter unless the tenant opts in. (c) Document the resulting matrix in the ROPA.
- **Effort:** S

---

## Observations (no clean article hook)

- **O3.1 — `experimental_context` will be renamed by the Vercel AI SDK.** The field is documented as experimental and may be renamed upstream; remediation for F3.2 should track SDK changes.
- **O3.2 — OpenRouter creates a cascading subprocessor chain.** Every call via OpenRouter resolves to a second-hop provider selected dynamically. Even if we cite an OpenRouter DPA, the downstream recipient is unknown per call — relevant for F3.10.
- **O3.3 — `ai_usage_logs.sessionId`** could be cross-referenced with session tokens to link AI usage to IP addresses via security audit logs. Flagged for Stream 4 linkage but not audited here.
- **O3.4 — Desktop app (`apps/desktop`)** was not deeply inspected; if Electron ships with auto-update pointing to a server, that is a separate processor surface. Stream 4 covers client-side telemetry.

---

## Checklist of what was examined

AI surface (read directly):
- `apps/web/src/lib/ai/core/ai-providers-config.ts` (lines 1-100, 480-510)
- `apps/web/src/app/api/ai/chat/route.ts` (lines 770-900)
- `packages/db/src/schema/monitoring.ts` (lines 140-210)

Billing / email / OAuth / integrations (read directly):
- `packages/lib/src/services/email-service.ts` (full, 60 lines)
- `apps/web/src/lib/stripe-customer.ts` (full, 65 lines)
- `packages/lib/src/integrations/providers/github.ts` (lines 1-80)
- `apps/web/src/app/api/integrations/google-calendar/callback/route.ts` (lines 1-50)
- `packages/lib/src/integrations/credentials/encrypt-credentials.ts` (full, 62 lines)
- `packages/lib/src/notifications/push-notifications.ts` (lines 120-180)

Deployment / infra (read directly):
- `packages/lib/src/deployment-mode.ts` (full, 30 lines)
- `/Users/jono/production/PageSpace-Deploy/DEPLOY.md` (lines 100-140)

Marketing / legal (read directly):
- `apps/marketing/src/app/privacy/page.tsx` (lines 1-240)

File processor (read directly):
- `apps/processor/src/workers/ocr-processor.ts` (lines 1-80)

Surveyed via subagent exploration (indirect — used for breadth, verified against direct reads where findings depended on specifics):
- `apps/web/src/lib/ai/core/provider-factory.ts`
- `apps/web/src/lib/ai/core/ai-utils.ts`
- `apps/web/src/app/api/voice/transcribe/route.ts`
- `apps/web/src/lib/stripe-config.ts`, `apps/web/src/lib/stripe/client.ts`
- `apps/web/src/app/api/stripe/webhook/route.ts` + `apps/web/src/app/api/stripe/**` routes
- `apps/control-plane/src/index.ts`, `apps/control-plane/src/routes/stripe-webhooks.ts`, `apps/control-plane/src/routes/tenants.ts`
- `packages/lib/src/auth/oauth-utils.ts`
- `apps/web/src/app/api/auth/google/native/route.ts`, `apps/web/src/app/api/auth/magic-link/send/route.ts`
- `apps/web/src/middleware/security-headers.ts`
- `apps/web/src/app/api/integrations/google-calendar/disconnect/route.ts` and `.../connect/route.ts`
- `packages/db/src/schema/` integration/calendar tables
- `packages/lib/src/logging/logger.ts`, `packages/lib/src/audit/security-audit.ts`
- `apps/processor/src/cache/content-store.ts`
- `apps/ios/package.json`, `apps/android/package.json`, `apps/desktop/package.json`
- `apps/web/src/app/api/cron/**`
- `/Users/jono/production/PageSpace-Deploy/docker-compose.prod.yml`
- `/Users/jono/production/PageSpace-Deploy/Caddyfile`
- `/Users/jono/production/PageSpace-Deploy/README.md`

Grep verifications run:
- `Data Processing Agreement|Standard Contractual|subprocessor|sub-processor|\bDPA\b|\bSCCs?\b` → 5 hits, all in `docs/security/compliance-sovereignty-analysis.md` (no source, deploy, or legal-page hits)
- `isOnPrem|isCloud|isTenantMode|DEPLOYMENT_MODE` in `apps/web/src/app/api/integrations/**` → zero hits (F3.20)
- `encrypt.*accessToken|integrationCredentials|encryptedCredentials` → confirmed `packages/lib/src/integrations/credentials/encrypt-credentials.ts` is the generic layer (informs F3.6 correction)

Cross-stream references:
- Stream 1 (DSR/retention) covers the DSAR surface (`/api/account/export`, `/api/admin/users/[userId]/export`) — F3.14 only adds the admin-action audit-logging angle; F3.19 flags a DSAR-export completeness gap for Calendar cache.
- Stream 2 (consent/legal pages) covers Art 8 children's consent on the privacy page — not re-audited here; F3.23 cross-links to §4 of the same privacy page.
- Stream 4 (`pu/audit-pii-masking`) covers PII in logs; this doc references `ai_usage_logs` as a secondary data store (F3.17) but does not audit its scrubbing policies.

---

*End of Stream 3 audit.*
