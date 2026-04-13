# Stream 2: Consent, Lawful Basis, Legal Pages

> **Scope:** GDPR Art 6 (lawful basis), Art 7 (consent), Art 8 (minors), Art 9 (special categories), Art 12–14 (information to data subjects), Art 22 (automated decisions), Art 25 (privacy by design/default), Art 27 (EU representative), Art 30 (records of processing), Art 35 (DPIA), Art 37 (DPO), Art 44–49 (transfers, disclosure side only).
>
> **Out of scope (other streams):** DSR/erasure (Stream 1), processor contracts and the actual transfer mechanism (Stream 3), security and breach notification (Stream 4 + `pu/audit-pii-masking`).
>
> **Method:** every finding cites a file path or — where the gap is the *absence* of an artifact — describes the grep that returned no matches. Anything I could not verify line-for-line in code is in the Observations Appendix, not the Findings.

## Summary

- **Cross-border transfers rest on user "consent"** with no SCCs, BCRs, or adequacy reference disclosed (`apps/marketing/src/app/privacy/page.tsx:196-198`). EDPB has consistently warned that consent under Art 49 is not a substitute for an Art 46 safeguard for systematic transfers; the policy text is the only place transfers are addressed.
- **The privacy policy never states a lawful basis** for any processing purpose. Art 13(1)(c) requires it explicitly. There is no mapping from purpose → Art 6 anywhere in the code, the policy, or `docs/`.
- **The data subject rights section is materially incomplete.** §8 of the privacy policy lists access, modification, deletion, export, and portability but omits restriction (Art 18), objection (Art 21), the right to withdraw consent (Art 7(3)), and the right to lodge a complaint with a supervisory authority (Art 13(2)(d)).
- **No cookie banner, no consent UI, no analytics opt-in exist anywhere in the repo.** A first-party tracker is mounted at the root layout and fires on every page, including unauthenticated signin/signup pages, and Google Identity Services is loaded as a third-party script before any user interaction.
- **No DPO, no Art 27 EU representative, no controller legal entity in the privacy policy, no DPIA, no Art 30 register, and no published subprocessor list.** The privacy contact is a generic `hello@pagespace.ai` address.
- **The per-provider AI consent system has been removed from code** (the surviving reference is in `docs/security/compliance-sovereignty-analysis.md:71-94`). For any deployment using a centrally-managed provider key, no per-user record exists that the user was informed their prompts and content leave the EU and reach Anthropic / OpenAI / Google / xAI.

## Findings

### F2.1 — TOS acceptance is hardcoded client-side; no affirmative-action UI for either passkey or magic-link signup

- **GDPR article(s):** Art 7(1) (controller must demonstrate consent), Art 4(11) (consent must be "a clear affirmative action"), Art 5(2) (accountability)
- **Severity:** medium
- **Deployment modes affected:** cloud, tenant
- **Location:**
  - `apps/web/src/components/auth/PasskeySignupButton.tsx:111` — client request body literally writes `acceptedTos: true` regardless of any UI element
  - `apps/web/src/app/api/auth/signup-passkey/route.ts:28-30` — backend Zod schema enforces `acceptedTos === true`, but the value is supplied by the client, not by a user gesture
  - `apps/web/src/app/auth/signup/page.tsx:154-168` — there is a browsewrap notice ("By signing up, you agree to our Terms and Privacy Policy") in the footer of the signup page
  - `apps/web/src/components/auth/MagicLinkForm.tsx` — no Terms/Privacy reference at all in the form itself; relies on whichever surrounding page hosts it (signup or signin page footer)
- **Current behavior:** The passkey signup form collects name + email and a WebAuthn credential. Before the credential is submitted, the user has not interacted with any consent control; the client just sets `acceptedTos: true`. The browsewrap notice is technically below the Continue button. The backend stores no per-user record of the consent gesture beyond the `tosAcceptedAt` timestamp set at user creation time.
- **Gap:** Art 7(1) requires the controller to "be able to demonstrate that the data subject has consented to processing" of any processing relying on consent. Art 4(11) requires a "clear affirmative action". Even where TOS acceptance is contractual rather than consent-based (Art 6(1)(b)), an unchecked-checkbox or no-checkbox pattern is not a *demonstrable* affirmative action: there is no per-user evidence that the user actually saw the policy. This is a recordkeeping and demonstrability gap, not the absence of notice.
- **Recommendation:** Add an explicit `Checkbox` in `PasskeySignupButton` and `MagicLinkForm` (state `tosAccepted`, default `false`, disable the submit button until checked). Plumb the checkbox state through the existing `acceptedTos` field. Persist the *version* of the policy accepted (today the schema only stores `tosAcceptedAt`; capture `tosAcceptedVersion` matching `LEGAL_LAST_UPDATED`).
- **Effort:** S

### F2.2 — Google One Tap submits credentials before the user can read any notice

- **GDPR article(s):** Art 13(1)(c)(d) (information at the time of collection), Art 7(2) (consent must be distinguishable and not bundled), Art 5(1)(a) (lawfulness, fairness, transparency)
- **Severity:** high
- **Deployment modes affected:** cloud
- **Location:**
  - `apps/web/src/app/auth/signup/page.tsx:59` — `<GoogleOneTap autoSelect={true} cancelOnTapOutside={true} context="signup" />` mounted at the very top of the signup page, before the heading
  - `apps/web/src/components/auth/GoogleOneTap.tsx:219-234` — calls `google.accounts.id.initialize` with `auto_select: true` and immediately calls `prompt()`
  - `apps/web/src/components/auth/GoogleOneTap.tsx:251-262` — appends `https://accounts.google.com/gsi/client` to `document.head` on mount
  - `apps/web/src/app/api/auth/google/one-tap/route.ts` — server creates an account on first credential receipt; no `acceptedTos` field is required on this code path (verified by reading the One Tap route's schema)
- **Current behavior:** When a visitor lands on `/auth/signup` or `/auth/signin`, the GoogleOneTap component mounts immediately. It loads the Google Identity Services script, then auto-selects an account (because `auto_select: true`) and presents the FedCM/One Tap prompt. A single click on that prompt will create an account server-side. The Terms/Privacy browsewrap notice is at the bottom of the page (signup `:154-168`, signin `:262-272`) and is not visible in the One Tap modal.
- **Gap:** Art 13(1)(c)/(d) require the controller's identity, the purposes, and the legal basis to be provided *at the time the data is obtained*. Google's own consent screen identifies *Google* as the recipient — it does not identify PageSpace as the controller, the purposes of processing, the legal basis, the recipients, the retention period, or the data subject's rights. With `auto_select: true`, the prompt can resolve in one click without the user ever seeing the PageSpace-controlled notice. The One Tap credential-side route also does not require an `acceptedTos` field, so account creation occurs even though the passkey path has been gated on it.
- **Recommendation:** (a) remove `autoSelect={true}` from the signup mount until consent UX is in place, (b) gate `prompt()` behind an explicit "Continue with Google" button so the user has to click after seeing the in-page notice, (c) require `acceptedTos: true` on the One Tap server route just like the passkey route does, (d) move the Terms/Privacy footer text into a near-button position so it appears within the same fold as the One Tap prompt.
- **Effort:** S

### F2.3 — No age verification anywhere; privacy policy mentions only "under 13" (COPPA), not Art 8's 16-year default

- **GDPR article(s):** Art 8 (conditions applicable to a child's consent — default minimum age 16 unless a member state has lowered it; many member states still use 16)
- **Severity:** high
- **Deployment modes affected:** cloud, tenant
- **Location:**
  - `apps/marketing/src/app/privacy/page.tsx:163-167` — §9 "PageSpace is not intended for children under 13."
  - Schema sweep: `grep -r 'birthDate|dateOfBirth|parentalConsent|ageVerif|under-?16|under-?13'` in the worktree returns zero matches in `packages/db/src/schema/**` and zero matches in `apps/web/src/app/auth/**` and `apps/web/src/app/api/auth/**`. No DOB field exists anywhere in the DB or signup forms.
- **Current behavior:** Signup collects name + email and a passkey or Google credential or a magic-link token. There is no age question, no DOB capture, no parental-consent mechanism, no Google account-age signal consumed. The privacy policy claims a 13-year floor as a self-statement; the floor is not enforced anywhere in the data layer.
- **Gap:** Art 8(1) sets the default minimum age for consent to information society services at 16, with member-state derogations down to 13. Eight EU/EEA member states still use 16 (DE, NL, IE, LU, FR, HR, SK, RO at various points; treat as a moving target — verify with counsel). PageSpace serves "EU users" per the audit charter and has no mechanism to ascertain age, no parental-consent flow, and no policy text matching the GDPR threshold.
- **Recommendation:** (a) add a DOB field (or "I am at least 16" confirmation) to all three signup paths (passkey, magic-link, Google One Tap), (b) when DEPLOYMENT_MODE is `cloud` or `tenant`, block account creation when the user self-declares under the applicable threshold and present a parental-consent flow, (c) update privacy policy §9 to state the GDPR Art 8 position explicitly and align the COPPA statement with it.
- **Effort:** M

### F2.4 — No cookie banner / consent UI of any kind exists in the codebase

- **GDPR article(s):** Art 7 (consent), Art 6(1)(a) (where consent is the basis), Art 5(3) ePrivacy Directive (storage/access on terminal equipment requires prior informed consent for non-essential cookies)
- **Severity:** medium
- **Deployment modes affected:** all
- **Location:**
  - Repo-wide grep `CookieBanner|CookieConsent|cookie-banner|cookie-consent|cookieConsent` → **0 matches**.
  - `apps/marketing/src/lib/theme-cookie.ts` — sets `ps_theme` cookie with one-year max-age (functional, but never gated on consent)
  - `apps/marketing/src/components/ui/sidebar.tsx` — sidebar state cookie with one-year max-age
  - `apps/marketing/src/components/NavbarAuthButtons.tsx` — reads `ps_logged_in` cookie
  - `apps/web/src/lib/auth/cookie-config.ts` — session, `ps_logged_in`, device-token-handoff cookies
- **Current behavior:** The marketing site sets at least two long-lived cookies on first visit (`ps_theme`, sidebar state) without any consent gate. The web app sets a `ps_logged_in` indicator cookie that is non-`HttpOnly` (visible to JavaScript). No cookie disclosure UI is rendered anywhere.
- **Gap:** Strictly necessary cookies (session, CSRF, the magic-link handoff) are exempt from ePrivacy Art 5(3) consent. `ps_theme` and the sidebar-state cookie are arguably "functional" but are not strictly necessary to deliver the requested service in the ePrivacy sense — they are preference persistence. Most EU DPAs (CNIL, ICO, Datenschutzkonferenz) treat preference/UI cookies as requiring at least notice and the ability to refuse. There is no notice and no mechanism to refuse here. The bigger ePrivacy exposure is F2.21 (third-party Google script).
- **Recommendation:** (a) add a minimal cookie notice banner that distinguishes essential vs preference cookies; (b) gate the `ps_theme` and sidebar-state cookies on the user's choice or fall back to in-memory storage when refused; (c) pair with F2.18 (publish a Cookie Policy page).
- **Effort:** M

### F2.5 — First-party analytics tracker fires on every page, including unauthenticated pages, with no opt-in and no Art 13 notice

- **GDPR article(s):** Art 6 (lawful basis must exist and be stated), Art 13(1)(c) (basis must be disclosed at the time of collection), Art 5(1)(a) (transparency), Art 5(1)(c) (data minimisation — IP+UA enrichment)
- **Severity:** medium
- **Deployment modes affected:** all
- **Location:**
  - `apps/web/src/app/layout.tsx:160` — `<ClientTrackingProvider />` mounted in the root layout, inside `ThemeProvider`, before `{children}`
  - `apps/web/src/components/providers/ClientTrackingProvider.tsx:1-7` — 7-line stub that side-effect-imports `@/lib/analytics/client-tracker`
  - `apps/web/src/lib/analytics/client-tracker.ts:227-254` — auto-tracks page views on mount and patches `history.pushState`/`history.replaceState`/`popstate`
  - `apps/web/src/lib/analytics/client-tracker.ts:124-132` — `trackError` includes `window.location.href` and `navigator.userAgent`
  - `apps/web/src/app/api/track/route.ts:111-118` — server-side enriches every event with the client IP and User-Agent header
  - `apps/web/src/app/api/track/route.ts:104-109` — auth lookup is opportunistic; events are accepted with no user ID (i.e., from logged-out visitors)
- **Current behavior:** Every page render in the web app — including the unauthenticated `/auth/signup` and `/auth/signin` pages — triggers a `page_view` event on the next tick. The server stores IP and User-Agent for every event. There is no consent gate, no preference toggle, and no Art 13 notice on the landing surface.
- **Gap:** No Art 6 basis is stated for this processing in either the privacy policy or in code comments. If the basis is consent (Art 6(1)(a)), it must be obtained beforehand and is not. If the basis is legitimate interest (Art 6(1)(f)), Art 13(1)(d) requires that the legitimate interest be disclosed and a balancing test conducted; neither has been done. Either way the processing fails Art 13.
- **Recommendation:** (a) gate `ClientTrackingProvider` on consent state (or on a settings toggle) and default-off for unauthenticated visitors; (b) update the privacy policy to add an analytics section that names IP/UA collection and the legal basis; (c) consider truncating the IP server-side (`/24` or `/64`) and dropping User-Agent for non-error events to satisfy minimisation.
- **Effort:** M

### F2.6 — Per-provider AI consent system has been removed; no per-user record that prompts and content leave the EU

- **GDPR article(s):** Art 13(1)(e), Art 13(1)(f) (recipients and transfer mechanism), Art 7(1) (demonstrability), Art 24 (controller accountability), Art 44 (transfer notice)
- **Severity:** high
- **Deployment modes affected:** cloud, tenant (and `onprem` only when an admin configures a cloud provider key)
- **Location:**
  - Repo-wide grep `aiProviderConsents|requiresConsent|ai-consent-repository` → matches only `docs/security/compliance-sovereignty-analysis.md:71-94`. There are zero matches in code or schema.
  - `apps/marketing/src/app/privacy/page.tsx:69-82` — the only user-facing notice is generic prose in §4 ("Important: When using AI services, we send your prompts and relevant context to AI providers")
- **Current behavior:** The codebase used to gate the first call to a cloud AI provider behind a per-provider consent acknowledgement and store that acknowledgement in an `aiProviderConsents` table. That system was removed (per `docs/security/compliance-sovereignty-analysis.md`). Today, when a user uses a centrally-managed key (e.g., a shared OpenRouter or default Google AI key), there is no per-user record that the user was ever informed their prompts and context leave the EU and reach a third-party processor.
- **Gap:** Art 13(1)(e) requires disclosure of the recipients of personal data; Art 13(1)(f) requires the transfer mechanism. Art 7(1) requires the controller to demonstrate consent where consent is the basis. Even if PageSpace argues Art 6(1)(b) (contractual necessity), Art 13 disclosure obligations still apply at the moment of collection — the prose in §4 is too generic to satisfy "categories of personal data" or "transfer mechanism" requirements, and there is no record-of-acknowledgement to demonstrate that any specific user saw the disclosure.
- **Recommendation:** (a) restore a lightweight per-provider acknowledgement gate when the user first triggers a request on a centrally-managed key; (b) persist `userId, providerId, acknowledgedAt, policyVersion` on a new table; (c) when the user brings their own key (BYO), record only `byoAck`; (d) expand privacy policy §4 to list, per provider, the data categories sent, the transfer mechanism, and the retention at the processor (Stream 3 will provide the contractual side).
- **Effort:** M

### F2.7 — Privacy Policy never states a lawful basis under Art 6 for any processing purpose

- **GDPR article(s):** Art 13(1)(c)
- **Severity:** high
- **Deployment modes affected:** all
- **Location:** `apps/marketing/src/app/privacy/page.tsx:1-238` (entire file). Grep for `lawful basis|legal basis|Article 6|legitimate interest|contract|consent` returns either zero matches or false positives ("contract" appears only in a "service contract" sense; "consent" appears only in §12 as the transfer mechanism — see F2.9).
- **Current behavior:** The policy describes *what* PageSpace processes and *how* but never names *under which Art 6 basis*. There is no per-purpose breakdown.
- **Gap:** Art 13(1)(c) is unambiguous: at the time personal data is obtained, the controller must provide "the purposes of the processing for which the personal data are intended **as well as the legal basis for the processing**." Failure to state the basis in the privacy notice is a direct Art 13 violation that supervisory authorities routinely fine for.
- **Recommendation:** Add a "Legal Bases for Processing" section that maps each processing purpose to an Art 6(1) basis. The Legal Basis Mapping Table at the bottom of this audit can serve as a starting draft.
- **Effort:** S (drafting); M (legal review)

### F2.8 — Data subject rights section is materially incomplete

- **GDPR article(s):** Art 12, Art 13(2)(b), Art 13(2)(d), Art 7(3), Art 15–22
- **Severity:** high
- **Deployment modes affected:** all
- **Location:** `apps/marketing/src/app/privacy/page.tsx:148-160`
- **Current behavior:** §8 lists, verbatim:
  > "Access: All your data is accessible through the application interface
  > Modification: Edit or update any content at any time
  > Deletion: Delete individual items or your entire workspace
  > Export: Data export available by request - contact us for assistance
  > Portability: Your data is stored in standard formats"
- **Gap:** Missing rights / disclosures the section must contain to satisfy Art 13(2):
  - **Art 18** (right to restriction of processing) — not mentioned
  - **Art 21** (right to object, including for direct marketing) — not mentioned
  - **Art 7(3)** (right to withdraw consent at any time, where processing is based on consent) — not mentioned
  - **Art 13(2)(d)** (right to lodge a complaint with a supervisory authority) — not mentioned
  - The phrasing "Data export available by request - contact us for assistance" is also at odds with the actual code: there *is* a self-service export endpoint (Stream 1's territory) but the policy describes it as a manual process.
- **Recommendation:** Rewrite §8 to enumerate all rights under Arts 15–22 with a one-line description and the route for exercising each one. Name the supervisory authority pathway. Surface the self-service export path in the policy.
- **Effort:** S

### F2.9 — Cross-border transfer mechanism disclosed as user "consent" only; no SCC, BCR, or adequacy reference

- **GDPR article(s):** Art 13(1)(f), Art 44, Art 46, Art 49
- **Severity:** high
- **Deployment modes affected:** cloud, tenant
- **Location:** `apps/marketing/src/app/privacy/page.tsx:191-199`
- **Current behavior:** §12 verbatim:
  > "PageSpace is operated from the United States. If you are accessing our services from outside the United States, please be aware that your information may be transferred to, stored, and processed in the United States where our servers are located and our central database is operated.
  >
  > By using our service, you consent to the transfer of your information to the United States and processing in accordance with this Privacy Policy."
- **Gap:** EDPB Guidelines 05/2020 on consent and Recommendation 01/2020 on transfers establish that consent under Art 49(1)(a) is only valid as a derogation for *occasional, non-systematic* transfers and must be *explicit* and based on a clear warning of the risks (lack of essential equivalence in the US). It is not a substitute for an Art 46 safeguard for systematic transfers like a SaaS data flow. The text quoted above is a bundled, browsewrap-style consent and does not satisfy either Art 49 (it is not explicit or risk-aware) or Art 46 (no SCCs, no adequacy decision is named — the Data Privacy Framework is the current relevant route for US transfers and is not mentioned). Art 13(1)(f) also requires disclosure of the safeguards "by reference to the appropriate or suitable safeguards and the means by which to obtain a copy of them" — no such reference exists.
- **Recommendation:** Replace §12 with a disclosure that (a) identifies the actual transfer mechanism (Stream 3 will determine whether SCCs, the EU-US DPF, or both apply), (b) names the safeguards including a link to the SCC version in use, (c) names every receiving country (US plus any AI-provider jurisdictions), (d) discloses the residual risks. Stream 3 owns the contractual side; this finding only flags the *disclosure* gap, but the disclosure cannot be fixed until the underlying mechanism exists.
- **Effort:** L (depends on Stream 3 outcome)

### F2.10 — No DPO designated, no Art 27 EU representative, no specific privacy contact channel

- **GDPR article(s):** Art 13(1)(b), Art 27, Art 37
- **Severity:** medium
- **Deployment modes affected:** cloud, tenant
- **Location:**
  - `apps/marketing/src/app/privacy/page.tsx:218-231` (§15 Contact Us)
  - `apps/marketing/src/app/terms/page.tsx:205-217` (§16 Contact Information)
  - Repo-wide grep for `DPO|Data Protection Officer|DPIA|Article 30|Records of Processing` → matches only false-positive substrings in `ingest-sanitizer.ts` ("ENDPOINT" contains "DPO"), `pnpm-lock.yaml`, `.env.onprem.example`, and `scripts/check-fetch-auth.js`. No real reference exists.
- **Current behavior:** The privacy contact is `hello@pagespace.ai` with the instruction that data-protection requests should use the subject line "Data Protection Request". No DPO is named. No Art 27 EU representative is named. The terms identify "Jonathan Woodall as a sole proprietorship" with no postal address.
- **Gap:** Art 37 only obligates DPO designation in specific circumstances (large-scale processing of special categories, large-scale regular and systematic monitoring, or public-authority status). PageSpace plausibly does not strictly require a DPO under Art 37(1), but Art 13(1)(b) still requires "where applicable, the contact details of the data protection officer" — i.e., if the controller has *not* designated one, the policy should say so explicitly. Art 27 requires a controller not established in the EU but processing EU personal data on a non-occasional basis to designate an EU representative in writing; PageSpace markets to EU users (by the audit charter), is operated from the US, and processes EU personal data systematically. No EU representative is named.
- **Recommendation:** (a) decide whether DPO designation is needed; if not, state that explicitly; (b) designate an EU representative under Art 27 and publish their contact details in §15; (c) provide a dedicated `privacy@pagespace.ai` (or DPO-specific) inbox so requests do not collide with general support; (d) consider publishing a postal address for the controller.
- **Effort:** M (legal/operational, not code)

### F2.11 — No DPIA documented for AI processing, plaintext storage of user content, or first-party analytics

- **GDPR article(s):** Art 35, Art 25
- **Severity:** medium
- **Deployment modes affected:** cloud, tenant
- **Location:** Absence — repo-wide grep for `DPIA|Data Protection Impact Assessment` returns no genuine matches in `docs/`. The only file under `docs/security/` that addresses adjacent concerns is `docs/security/compliance-sovereignty-analysis.md`, which is sovereignty-focused, not a DPIA.
- **Current behavior:** PageSpace performs (a) systematic transmission of user prompts and surrounding context to multiple cloud AI providers, (b) stores all document and chat content in plaintext to enable AI regex search (per `docs/security/compliance-sovereignty-analysis.md:51-57`), (c) operates a first-party analytics surface that processes IP and User-Agent of every visitor. None of these have a DPIA on record.
- **Gap:** Art 35(1) requires a DPIA "where a type of processing in particular using new technologies, and taking into account the nature, scope, context and purposes of the processing, is likely to result in a high risk to the rights and freedoms of natural persons". Art 35(3)(a) explicitly lists "systematic and extensive evaluation of personal aspects... including profiling" and (b) processing on a large scale of Art 9 special categories. Most EU DPAs have published DPIA-required lists that include (i) systematic monitoring of behaviour, (ii) processing involving AI, and (iii) cross-border transfers of large data volumes — all of which apply here.
- **Recommendation:** Conduct a DPIA covering (a) AI provider transmission, (b) plaintext content storage, (c) first-party analytics. Publish the DPIA summary, store the full document under `docs/security/dpia/`, and reference it in the privacy policy.
- **Effort:** L

### F2.12 — No Art 30 Records of Processing register exists in the repo

- **GDPR article(s):** Art 30
- **Severity:** medium
- **Deployment modes affected:** all
- **Location:** Absence — no file under `docs/` matches `Records of Processing|Article 30|RoPA`. The audit log table (`packages/db/src/schema/security-audit.ts`) is an event log, not a register of processing activities.
- **Current behavior:** No Art 30 register is maintained as code, as docs, or as a published artifact.
- **Gap:** Art 30(1) requires every controller to maintain a record of processing activities under its responsibility, including the categories of data subjects, the categories of personal data, recipients, transfers (and the documentation of suitable safeguards), retention periods, and a description of the technical and organisational measures. Art 30(5) exempts entities with fewer than 250 employees only when processing is occasional, does not include special categories, and is unlikely to result in risk — none of which apply here. PageSpace is required to maintain this register regardless of headcount.
- **Recommendation:** Create `docs/security/ropa.md` with a per-purpose breakdown that mirrors the Legal Basis Mapping Table at the bottom of this audit. Keep it under version control so changes are auditable.
- **Effort:** M

### F2.13 — Default-on transactional notifications send first email before any in-app Art 13 notice (esp. invitations to non-users)

- **GDPR article(s):** Art 13(1)(c)(e), Art 14 (information where data not obtained from the subject), Art 7 (where consent is the basis)
- **Severity:** low
- **Deployment modes affected:** cloud, tenant
- **Location:**
  - `packages/db/src/schema/email-notifications.ts:8-18` — `emailEnabled` defaults to `true`
  - `packages/db/src/schema/notifications.ts` — `notificationType` enum (PERMISSION_GRANTED, PERMISSION_REVOKED, PAGE_SHARED, DRIVE_INVITED, DRIVE_JOINED, CONNECTION_REQUEST, NEW_DIRECT_MESSAGE, EMAIL_VERIFICATION_REQUIRED, TOS_PRIVACY_UPDATED, MENTION, TASK_ASSIGNED, …)
  - `packages/lib/src/services/notification-email-service.ts` — emits unsubscribe tokens and sends mail via Resend
  - `apps/web/src/app/api/notifications/unsubscribe/[token]/route.ts` — unsubscribe handler
- **Current behavior:** All email notification preferences default to `emailEnabled = true`. There is no marketing/newsletter notification type — every type is operational. However, two of the operational types (`DRIVE_INVITED`, `CONNECTION_REQUEST`, plausibly `PAGE_SHARED` of a public page) can dispatch email to addresses that do not yet have a PageSpace account. Those recipients have no prior in-app contact with PageSpace and have not seen the privacy policy at the moment they receive the first email.
- **Gap:** For *existing* users, default-on transactional notifications are defensible under Art 6(1)(b) (contractual necessity) and ePrivacy Art 6(1) (transactional emails to one's own customers). For *non-user* invitees, Art 14 applies — PageSpace becomes a controller of the invitee's email address as soon as it is received, and Art 14(1)–(2) require that controller to provide its identity, the purposes, the legal basis, the source, the retention period, and the rights "within a reasonable period after obtaining the personal data, but at the latest within one month" or "at the latest at the time of the first communication". The current first-touch email does not embed this Art 14 disclosure.
- **Recommendation:** (a) embed an Art 14 footer in invitation emails that names the controller, the purpose, the source of the email address (the inviter), how to opt out, and how to lodge a complaint; (b) document the lawful basis (legitimate interest of the inviter to invite the recipient) and conduct an LIA; (c) add an unsubscribe-from-all-future-invites mechanism keyed on the email address (not just the user account).
- **Effort:** S

### F2.14 — Stripe checkout shows no in-flow Art 13 notice; relies on the privacy-policy link only

- **GDPR article(s):** Art 13(1)(c)(e)
- **Severity:** low
- **Deployment modes affected:** cloud
- **Location:** `apps/web/src/app/api/stripe/create-subscription/route.ts` (entire file) — server-side route that creates a Stripe subscription with `payment_behavior: 'default_incomplete'`. The client-side checkout uses Stripe Elements (no in-flow PageSpace-rendered Art 13 notice).
- **Current behavior:** Subscribers click a paywall button, the server creates the Stripe subscription, and the client renders a Stripe-hosted card form. The only privacy disclosure is a generic mention in `apps/marketing/src/app/privacy/page.tsx:201-209` (§13 Payment and Billing).
- **Gap:** Art 13 information must be provided "at the time when personal data are obtained". The first time PageSpace forwards billing-address-relevant fields to Stripe is at checkout, and the user is not surfaced with a per-checkout disclosure that Stripe is the recipient and processor. Stripe's own checkout shows Stripe's notice, not PageSpace's.
- **Recommendation:** Add a one-line in-checkout disclosure ("Payment is processed by Stripe; see our Privacy Policy for details") and a link.
- **Effort:** S

### F2.15 — Automated decision-making position not stated either way

- **GDPR article(s):** Art 22, Art 13(2)(f)
- **Severity:** low
- **Deployment modes affected:** all
- **Location:** Absence in `apps/marketing/src/app/privacy/page.tsx`. Grep returns no matches for `automated decision|profiling|Article 22`.
- **Current behavior:** PageSpace's AI features clearly do not produce decisions with legal effect on data subjects (Art 22(1) does not apply on the strict reading). However, Art 13(2)(f) requires the controller to disclose either *the existence of automated decision-making, including profiling*, or *the absence of it*, when the question is in scope. The privacy policy is silent.
- **Gap:** Strictly speaking, Art 13(2)(f) only requires disclosure where automated decision-making exists. Best practice (and ICO guidance) is to state explicitly when it does not, especially for AI-heavy products where users may reasonably suspect it does. The absence-of-statement leaves users unable to verify their position.
- **Recommendation:** Add a one-paragraph statement to the privacy policy: "PageSpace does not perform automated decision-making producing legal or similarly significant effects under Article 22 GDPR. AI features generate suggestions and content; users remain in control of all decisions."
- **Effort:** S

### F2.16 — No subprocessor list as a separate, dated, change-notified document

- **GDPR article(s):** Art 28(2), Art 28(4), Art 13(1)(e)
- **Severity:** medium
- **Deployment modes affected:** cloud, tenant
- **Location:**
  - `apps/marketing/src/app/privacy/page.tsx:69-82` — §4 mentions OpenRouter, Google AI, Anthropic, OpenAI in prose
  - `apps/marketing/src/app/privacy/page.tsx:202-208` — §13 mentions Stripe
  - No `apps/marketing/src/app/subprocessors/` route or any equivalent under `docs/`
- **Current behavior:** Processors are mentioned in prose with no version, no date, no commitment to advance notice of additions, no contractual reference, and no link to a DPA.
- **Gap:** Art 28(2) requires the processor to obtain prior specific or general written authorisation from the controller before engaging another processor and, in the case of general written authorisation, "the processor shall inform the controller of any intended changes concerning the addition or replacement of other processors, thereby giving the controller the opportunity to object". By extension, where the *controller* uses subprocessors to deliver service to its own customers, the same expectation flows downstream — subprocessor lists are the standard mechanism. Most enterprise customers will not sign a DPA without one.
- **Recommendation:** Create `apps/marketing/src/app/subprocessors/page.tsx` with: name, purpose, data categories, region(s), transfer mechanism, link to processor's own DPA. Commit to 30-day advance notice of new subprocessors. Reference this page from the privacy policy §4. Stream 3 will provide the processor inventory.
- **Effort:** M

### F2.17 — Controller identity is not named in the Privacy Policy; Terms names a sole proprietorship without a postal address

- **GDPR article(s):** Art 13(1)(a)
- **Severity:** high
- **Deployment modes affected:** all
- **Location:**
  - `apps/marketing/src/app/privacy/page.tsx:218-231` — §15 lists only `hello@pagespace.ai`, Discord, and "in-app help"; no legal entity, no address
  - `apps/marketing/src/app/terms/page.tsx:205-217` — §16 names "Jonathan Woodall as a sole proprietorship" but no address, no jurisdiction of registration, no representative
- **Current behavior:** No data subject reading the privacy policy in isolation can identify who the controller is. The Terms identify the operator but only by a personal name.
- **Gap:** Art 13(1)(a) requires "the identity and the contact details of the controller and, where applicable, of the controller's representative". A name and an email is the bare minimum and arguably below it for a SaaS controller; a postal address is expected. Without this, data subjects cannot exercise their rights against an identified entity.
- **Recommendation:** Add the controller's full legal identity (legal name, type of entity, jurisdiction, postal address, and the Art 27 EU representative once designated — see F2.10) to privacy policy §15. Mirror it in Terms §16.
- **Effort:** S

### F2.18 — No Cookie Policy document; cookies referenced obliquely in the Security section only

- **GDPR article(s):** Art 13, Art 5(3) ePrivacy
- **Severity:** low
- **Deployment modes affected:** all
- **Location:** Absence — no file under `apps/marketing/src/app/cookies/` or similar. The privacy policy mentions cookies only in §7 (line 136) where it lists "HTTP-only cookies" as a security technique, not as a transparency disclosure.
- **Current behavior:** Cookies set by the marketing site (`ps_theme`, sidebar state, `ps_logged_in`) and the web app (session, CSRF, device handoff) are not enumerated anywhere user-facing.
- **Gap:** ePrivacy / national implementations require disclosure of cookie names, purposes, durations, and third parties. CNIL's 2020/2021 guidance is the practical baseline.
- **Recommendation:** Publish `apps/marketing/src/app/cookies/page.tsx` with a per-cookie table (name, purpose, type, duration, party, basis). Pair with the cookie banner in F2.4.
- **Effort:** S

### F2.19 — No retention period stated per data category — Privacy §11 says only "reasonable timeframe"

- **GDPR article(s):** Art 13(2)(a), Art 5(1)(e)
- **Severity:** medium
- **Deployment modes affected:** all
- **Location:** `apps/marketing/src/app/privacy/page.tsx:176-189`
- **Current behavior:** §11 verbatim:
  > "We retain your data for as long as: Your account remains active / Needed to provide you with services / Required by law or for legitimate business purposes. When you delete your account, we will delete your personal data within a reasonable timeframe, except where we are required to retain it by law."
- **Gap:** Art 13(2)(a) requires "the period for which the personal data will be stored, or if that is not possible, the criteria used to determine that period". The current text uses circular criteria ("as long as your account is active") and an undefined "reasonable timeframe" for deletion. There is no per-category breakdown for audit logs, AI usage logs, backups, soft-deleted content, etc.
- **Recommendation:** Replace §11 with a table per data category (account data, content, chat history, audit logs, billing records, backups) listing either an explicit period or the criteria. Stream 1 owns the actual retention behaviour; this finding is the disclosure side.
- **Effort:** S

### F2.20 — `onprem` mode disables self-signup but not the analytics tracker; consent surface is mode-agnostic

- **GDPR article(s):** Art 25 (privacy by design and by default)
- **Severity:** low
- **Deployment modes affected:** onprem
- **Location:**
  - `packages/lib/src/deployment-mode.ts:15-29` — three flag functions, no consent/analytics flag
  - `apps/web/src/app/layout.tsx:160` — `<ClientTrackingProvider />` with no `if (isOnPrem()) return null` guard
  - `apps/web/src/components/providers/ClientTrackingProvider.tsx:1-7` — 7-line stub, no mode awareness
- **Current behavior:** When PageSpace is deployed on-prem (a self-hosted scenario where the tenant administrator owns the data), the same client-side tracker still loads and POSTs page views to `/api/track`. In an on-prem deployment, that endpoint is local, so the data does not leave the customer's perimeter — but the customer still has no way to disable the tracking, and any future change that points the tracker at a hosted endpoint would silently leak.
- **Gap:** Art 25(2) requires the controller to "implement appropriate technical and organisational measures for ensuring that, by default, only personal data which are necessary for each specific purpose of the processing are processed". For an on-prem build, first-party analytics is rarely necessary; defaults should reflect that. Today there is no opt-out and no kill-switch.
- **Recommendation:** (a) gate `ClientTrackingProvider` on `!isOnPrem()` (or on an explicit `ENABLE_ANALYTICS` flag), (b) add `isAnalyticsEnabled()` to `deployment-mode.ts`, (c) document the flag in `.env.onprem.example`.
- **Effort:** S

### F2.21 — Google Identity Services third-party script loaded without prior consent

- **GDPR article(s):** Art 5(3) ePrivacy, Art 25 (privacy by default), Art 13(1)(e)(f) (recipient and transfer disclosure)
- **Severity:** medium
- **Deployment modes affected:** cloud
- **Location:**
  - `apps/web/src/components/auth/GoogleOneTap.tsx:251-262` — appends `https://accounts.google.com/gsi/client` to `document.head` on mount, no consent gate
  - `apps/web/src/app/auth/signup/page.tsx:59` and `apps/web/src/app/auth/signin/page.tsx` — mount the One Tap component on every visit
- **Current behavior:** When a visitor lands on the signup or signin page, the GIS script is fetched from `accounts.google.com` before any user interaction. Loading the script causes the browser to send the visitor's IP and User-Agent to Google and to receive any cookies Google sets on its own domain (subject to the visitor's existing Google cookie state).
- **Gap:** Under the ePrivacy Directive Art 5(3), the act of *storing or accessing* information on the user's terminal equipment requires prior informed consent unless strictly necessary to deliver the service the user requested. A visitor who has not yet clicked "Sign in with Google" has not requested any Google-mediated service; loading the GIS script preemptively is not strictly necessary. Several EU DPAs (CNIL on Google Fonts, Datenschutzkonferenz on similar third-party preloading) have ruled that fetching third-party assets without consent is itself a violation, regardless of cookie state. In addition, the recipient (Google LLC, US) and the transfer is not disclosed in the privacy policy.
- **Recommendation:** Load the GIS script lazily, only after the user clicks an in-page "Sign in with Google" button. Disable `auto_select`. Document Google as a recipient and processor in the privacy policy and the (yet-to-exist) subprocessor list.
- **Effort:** S

## Legal Basis Mapping Table

This is the table required by the audit charter. Each row maps a processing purpose to an Art 6(1) basis with the file path that creates the processing.

| # | Processing purpose | Categories of personal data | Art 6 basis | File path | Notes / linked finding |
|---|--------------------|----------------------------|-------------|-----------|------------------------|
| 1 | Account creation (passkey signup) | name, email, IP, User-Agent, WebAuthn credential ID, device platform | Art 6(1)(b) contract — performance of pre-contractual measures and the contract itself | `apps/web/src/app/api/auth/signup-passkey/route.ts:1-300`; `packages/lib/src/auth/passkey-service.ts` | F2.1 (no demonstrable affirmative action) |
| 2 | Account creation (Google OAuth / One Tap) | Google `sub`, email, name, profile picture URL, IP, User-Agent | Art 6(1)(b) | `apps/web/src/app/api/auth/google/one-tap/route.ts`; `apps/web/src/app/api/auth/google/callback/route.ts` | F2.2, F2.21 |
| 3 | Account creation (magic link) | email, IP, User-Agent | Art 6(1)(b) | `apps/web/src/app/api/auth/magic-link/send/route.ts:1-240`; `apps/web/src/app/api/auth/magic-link/verify/route.ts` | F2.1 |
| 4 | Session management | session token (hashed), `ps_logged_in` cookie, device token | Art 6(1)(b) | `packages/lib/src/auth/**`; `apps/web/src/lib/auth/cookie-config.ts` | — |
| 5 | Authentication audit logs | userId, IP, UA, event type, timestamp | Art 6(1)(c) legal obligation (record-keeping for security) and Art 6(1)(f) legitimate interest in fraud/abuse prevention | `packages/lib/src/audit/**`; `apps/web/src/app/api/auth/**` (every route calls `auditRequest`) | Stream 4 territory |
| 6 | Rate-limit IP collection | IP | Art 6(1)(f) legitimate interest in service availability | `packages/lib/src/security/**`; every auth route | LIA not documented |
| 7 | Stripe billing & subscription | name, email, billing address, Stripe customer ID, payment status | Art 6(1)(b) | `apps/web/src/app/api/stripe/**` | F2.14, Stream 3 |
| 8 | Email notifications (operational) — to existing users | email, notification type | Art 6(1)(b) and Art 6(1)(f) | `packages/lib/src/services/notification-email-service.ts`; `packages/db/src/schema/email-notifications.ts:8-18` | — |
| 9 | Email notifications — invitation to non-users | invitee email, inviter ID, drive/page reference | Art 6(1)(f) inviter's legitimate interest, with Art 14 obligations | `packages/lib/src/services/notification-email-service.ts` | F2.13 |
| 10 | AI prompt and context transmission to third-party providers | prompt content, conversation history, system prompts, sometimes file contents | **Currently undocumented**. Art 6(1)(b) is defensible only when the user explicitly chose the AI provider; for shared/default keys the only viable basis is Art 6(1)(a) consent — and consent is not collected. | `apps/web/src/lib/ai/**`; `packages/lib/src/services/ai-*` | F2.6, Stream 3 |
| 11 | First-party analytics (`/api/track`) | path, referrer, screen size, IP, User-Agent, optional userId | **Currently undocumented**. Either Art 6(1)(a) (not collected) or Art 6(1)(f) (LIA not documented, no opt-out). | `apps/web/src/lib/analytics/client-tracker.ts`; `apps/web/src/app/api/track/route.ts` | F2.5 |
| 12 | Plaintext content storage (documents, chat) for full-text & AI search | All user-generated content | Art 6(1)(b) | `packages/db/src/schema/core.ts`; `packages/db/src/schema/chat.ts` | Risk surface, see F2.11 |
| 13 | Theme + sidebar preference cookies | preference value | Art 6(1)(f) or Art 6(1)(a); not stated | `apps/marketing/src/lib/theme-cookie.ts`; `apps/marketing/src/components/ui/sidebar.tsx` | F2.4, F2.18 |
| 14 | Google Identity Services preloading | IP, UA exposed to Google | None established; ePrivacy Art 5(3) consent not obtained | `apps/web/src/components/auth/GoogleOneTap.tsx:251-262` | F2.21 |
| 15 | TOS/Privacy update notification | email, TOS version | Art 6(1)(b) and Art 6(1)(c) | `packages/db/src/schema/notifications.ts` (`TOS_PRIVACY_UPDATED` type) | — |
| 16 | Children processing | none — no DOB collected | n/a — but Art 8 still requires age check before consent for ISS to children | n/a | F2.3 |

## Observations Appendix

These items came up during review but do not map cleanly to a GDPR article in their own right, or are duplicates of work owned by other streams.

- **Browsewrap notice on signup pages does mention Terms and Privacy.** The signup page footer at `apps/web/src/app/auth/signup/page.tsx:154-168` and the equivalent on signin (`:262-272`) both link to `/terms` and `/privacy`. F2.1 is therefore a *demonstrability* and *affirmative-action* finding, not a "no notice" finding.
- **Backend does enforce TOS acceptance.** `apps/web/src/app/api/auth/signup-passkey/route.ts:28-30` rejects a signup if `acceptedTos !== true`. The gap is that the value comes from the client without a user gesture, not that the gate is missing.
- **There is no marketing email category at all.** The notification type enum has no newsletter/promotional value. The risk in F2.13 is therefore narrowly about invitee emails, not bulk marketing.
- **Magic link signup creates an account on first send.** `apps/web/src/app/api/auth/magic-link/send/route.ts` handles both new and existing users through the same code path; `acceptedTos` is not a parameter there. This means a user can create an account without ever passing through the passkey TOS gate. Worth recording, but the substance is captured by F2.1.
- **`tosAcceptedAt` is the only consent-evidence column** in the user schema; there is no `tosAcceptedVersion`. If `LEGAL_LAST_UPDATED` changes, the controller cannot demonstrate which version each user accepted. F2.1 recommendation includes this fix.
- **The signup page footer position matters.** With Google One Tap mounted at the top (`signup/page.tsx:59`) and the Terms/Privacy footer at the bottom (`:154-168`), a viewport that fits only the One Tap modal and the heading will not show the notice at all. This is the surface F2.2 is concerned about.
- **`docs/security/compliance-sovereignty-analysis.md:71-94` documents the removed AI provider consent system.** F2.6 cites this; the documentation is the only surviving reference.
- **Self-service export endpoint exists** (Stream 1's territory). The privacy policy §8 line "Data export available by request - contact us for assistance" is more conservative than the actual implementation. Surfaced for Stream 1 to corroborate.
- **Hash-chain audit integrity** at `packages/lib/src/monitoring/hash-chain-verifier.ts` is mentioned in the spec as a Stream 4 concern; not examined here.
- **`tosAcceptedAt` is set inside `verifySignupRegistration`.** I did not read the function body line-by-line; if Stream 4 reviews the auth code path it can verify.

## Checklist of what was examined

Files I read directly (line-by-line or significant sections) during this audit:

- `apps/web/src/app/auth/signup/page.tsx` (1-172, full file)
- `apps/web/src/components/auth/PasskeySignupButton.tsx` (1-260, full file)
- `apps/web/src/components/auth/GoogleOneTap.tsx` (200-283; verified script-loading behaviour)
- `apps/web/src/components/auth/MagicLinkForm.tsx` (1-50, plus targeted greps for `terms|privacy|consent|checkbox`)
- `apps/web/src/app/api/auth/signup-passkey/route.ts` (1-100; schema and handler entry)
- `apps/web/src/app/auth/signin/page.tsx` (targeted greps: line 14, 26, 142, 225, 227, 233, 266-271)
- `apps/web/src/app/api/track/route.ts` (full file)
- `apps/web/src/lib/analytics/client-tracker.ts` (full file)
- `apps/web/src/components/providers/ClientTrackingProvider.tsx` (full file)
- `apps/web/src/app/layout.tsx` (150-167)
- `apps/marketing/src/app/privacy/page.tsx` (1-238, full file)
- `apps/marketing/src/app/terms/page.tsx` (1-60, plus targeted grep at 88, 207, 210)
- `packages/db/src/schema/email-notifications.ts` (1-50, full file)
- `packages/lib/src/deployment-mode.ts` (1-30, full file)

Files inspected via Glob/Grep (used as evidence for *absence* of artifacts):

- `apps/web/src/app/auth/**/page.tsx` — three pages exist (`email-verified`, `signin`, `signup`); no `/auth/magic-link` route
- Repo-wide grep `aiProviderConsents|requiresConsent|ai-consent-repository` — only `docs/security/compliance-sovereignty-analysis.md`
- Repo-wide grep `CookieBanner|CookieConsent|cookie-banner|cookie-consent|cookieConsent` — zero matches
- Repo-wide grep `DPO|Data Protection Officer|DPIA|Article 30|Records of Processing` — only false-positive substrings (`ENDPOINT` containing "DPO") plus `pnpm-lock.yaml`, `.env.onprem.example`, `scripts/check-fetch-auth.js`
- `packages/db/src/schema/**` grep `birthDate|dateOfBirth|parentalConsent|ageVerif|under-?16|under-?13` — zero genuine matches
- `packages/db/src/schema/auth.ts` grep `birthDate|dateOfBirth|\bdob\b|parentalConsent` — zero matches

Files referenced from the prior survey but not re-read in code (relied on `docs/security/compliance-sovereignty-analysis.md`):

- `apps/web/src/app/api/auth/google/one-tap/route.ts` (read by Explore agent; specific Art 13 obligations on this route should be re-confirmed by anyone implementing the F2.2 fix)
- `apps/web/src/app/api/auth/google/callback/route.ts`
- `apps/web/src/app/api/auth/magic-link/send/route.ts`
- `apps/web/src/app/api/auth/magic-link/verify/route.ts`
- `apps/web/src/app/api/stripe/create-subscription/route.ts`
- `apps/web/src/app/api/notifications/unsubscribe/[token]/route.ts`
- `packages/lib/src/services/notification-email-service.ts`
- `packages/lib/src/services/email-service.ts`
- `packages/lib/src/auth/passkey-service.ts`
- `apps/marketing/src/lib/metadata.ts` (`LEGAL_LAST_UPDATED`)
- `apps/marketing/src/lib/theme-cookie.ts`
- `apps/marketing/src/components/SiteFooter.tsx`

## Out of scope / handed off

- **Erasure, retention enforcement, export completeness** → Stream 1 (`01-dsr-retention.md`).
- **Processor inventory, contractual transfer mechanism, data-residency analysis** → Stream 3 (`03-processors-transfers.md`). F2.6, F2.9, F2.16 flag the *disclosure* gap; the contractual side belongs to Stream 3.
- **PII in non-audit logs, breach-notification pipeline, encryption at rest** → Stream 4 + the in-flight `pu/audit-pii-masking` branch.
