# Issue Triage — automated audit (2026-06-22)

Triage of all **132 open issues** via multi-agent sweep, then adversarial verification of every "resolved" verdict before closing. Method: each issue was checked against the current codebase; an issue was only closed when the code *provably* contradicts it (with `file:line` evidence) **and** a second independent agent failed to refute that finding. Issues that are decisions of intent (policy/legal text, deliberate future epics, product/design calls, unreproducible reports) were left open and flagged here.

**Totals:** 17 closed · 28 flagged (intent/decision) · 87 still-valid open bugs/gaps · 132 accounted for.

The adversarial pass demoted 6 candidates that looked resolved but were not: #1178, #1050, #978, #972, #918, #917 (details in the still-valid table). One issue (#1178) was closed and then reopened after a mapping error was caught.

---

## 1. Closed as resolved (17)

Each was closed as `completed` with an evidence comment on the issue; reopen if a case remains.

| # | Title | Proof it's resolved |
|---|-------|---------------------|
| #1209 | bug(tasks): task list filter preferences are not persisted | Filter prefs ARE persisted: useLayoutStore.ts persist middleware (taskListPageFilters in partialize) + re-applied in TaskListView.tsx |
| #1208 | bug(invites): user invite flow has no option to invite non-existent user | Email-invite of non-existent user exists: members/invite/page.tsx:114-158 -> POST /api/drives/{id}/members/invite creates invite token |
| #1156 | feat(ui): add dedicated DM UI back to dashboard inbox | Dedicated DM UI wired: dashboard/dms/page.tsx -> DMCenterList, nav via PrimaryNavigation, /api/inbox?type=dm |
| #1059 | storage: processor upload cap is flat + disagrees with env default, bypasses tiered storage-limits | Flat processor cap removed: processor upload router deleted (#1513); presign route validateFileSize(fileSize, quota.tier) |
| #968 | [GDPR] S4:F4: Session and bearer token storage uses SHA-256 hashing — confirmed correct | Informational; token storage uses SHA3-256 (token-utils.ts:26,43), correct/stronger. No action item. |
| #952 | [GDPR] F3.12: BYOK ambiguity: PageSpace handles plaintext even when user brings own key | BYOK ambiguity gone: provider-factory.ts managed keys only ('No per-user keys'); no user-key path |
| #948 | [GDPR] F3.8: External OCR silently ships extracted text to Google AI vision model | External OCR disabled: ocr-processor.ts performAIVisionOCR off, Tesseract fallback, gated by ENABLE_EXTERNAL_OCR |
| #941 | [GDPR] F3.1: Default AI tier routes prompts to Z.AI (China) with no Art 46 mechanism | Default not Z.AI: model-defaults.ts:6-7 DEFAULT openai/gpt-5.3-chat via OpenRouter; premise outdated (general Art 46 -> #955) |
| #920 | [GDPR] F2.1: TOS acceptance hardcoded client-side; no affirmative-action UI for passkey or magic-lin | Affirmative ToS UI exists: PasskeySignupButton.tsx:254 + MagicLinkForm.tsx:249 unchecked-by-default checkbox gates signup |
| #907 | [GDPR] F-17-3: No persistent search or vector index found — documented for completeness; no erasure | No persistent search/vector index in schema; issue itself notes no erasure path needed. Not actionable. |
| #905 | [GDPR] F-17-1: Physical file erasure is eventual via Sunday cron; content-addressed files may persis | Immediate physical erasure: trash/[pageId]/route.ts:90 calls reapOrphanedFiles synchronously on delete (subtree-scoped) |
| #903 | [GDPR] F-15-3: Activities export truncates at 10,000 rows — long-term users lose audit history | No 10k truncation: activities/export/route.ts:230-261 paginated loop BATCH_SIZE=1000, no total cap |
| #902 | [GDPR] F-15-2: Received direct messages are not exported (only sender-side queries used) | Received DMs exported: gdpr-export.ts:344-386 queries senderId!=userId, direction='received', in allUserData.messages |
| #858 | Wire up SIEM adapter — implemented but never called | SIEM adapter wired+called: processor queue-manager.ts:225-233 registers processSiemDelivery (pg-boss) -> deliverToSiemWithRetry |
| #621 | [UI] Task 33: Agent integration panel | Agent integration panel implemented: AgentIntegrationsPanel.tsx:1-412 (toggle/filter/read-only/bundles), rendered AiChatView.tsx:936 |
| #620 | [UI] Task 32: Drive integrations admin page | Drive integrations admin page: settings/integrations/page.tsx + DriveIntegrations.tsx, connect/disconnect, admin-gated |
| #542 | [Audit] Hash-chain concurrent write race — activity_logs can fork | Hash-chain race serialized: activity-logger.ts:485 pg_advisory_xact_lock covers read+insert within txn |

## 2. Flagged — intent / decision required (28)

Not closeable from code: legal/policy artifacts, deliberate future epics, product/design decisions, or unreproducible reports. Left open; each needs an owner decision (legal/product vs engineering).

| # | Title | Why it's a decision, not a code bug |
|---|-------|-------------------------------------|
| #1202 | bug(theme): mobile colors appear corrupted - navbar half in light mode | Mobile navbar half-light theme bug; unreproducible/device-specific; needs repro+product decision |
| #1179 | ai-streams: aiStreamSessions row carries no parts payload — restore depends on live multicast | ai-streams schema has no parts payload by design (P2 write-amplification tradeoff); decision |
| #1155 | fix(ui): mobile dark mode theme switching produces wrong colors | Mobile dark-mode wrong colors; unreproducible/device-specific; needs repro |
| #979 | [GDPR] S4:F15: Breach notification pipeline absent; no runbook, no incident table, no notify path | No incident table/runbook; breach-notification pipeline = policy/process artifact |
| #964 | [GDPR] F3.24: Tenant mode inherits full cloud AI provider set with no filtering | tenant-mode AI provider filtering = policy/product decision (provider-factory.ts:88-96) |
| #963 | [GDPR] F3.23: Privacy page omits default AI provider and four other AI services | Privacy page AI-provider completeness = legal/policy review |
| #962 | [GDPR] F3.22: Lets Encrypt CA and DNS relationships not recorded as processors | LetsEncrypt CA + DNS as processors = DPA/subprocessor artifact |
| #961 | [GDPR] F3.21: Onprem Azure OpenAI allows any region with no guidance docs | Onprem Azure region validation/guidance = policy/doc decision |
| #958 | [GDPR] F3.18: Control plane holds tenant owner email and Stripe customer IDs | Control plane holds owner email + Stripe IDs; = DPA/processor artifact |
| #956 | [GDPR] F3.16: pg_dump backups are plaintext, not encrypted at rest | pg_dump backups plaintext = ops/backup-encryption policy artifact |
| #953 | [GDPR] F3.13: No documented processor breach-notification pipeline | No documented processor breach-notification pipeline = policy artifact |
| #951 | [GDPR] F3.11: No Records of Processing Activities (Art 30) document anywhere | No Art 30 Records of Processing document = legal artifact |
| #935 | [GDPR] F2.16: No subprocessor list as a separate, dated, change-notified document | No subprocessor list as separate dated change-notified document = legal artifact |
| #931 | [GDPR] F2.12: No Art 30 Records of Processing register exists in docs or code | No Art 30 Records of Processing register = legal artifact |
| #930 | [GDPR] F2.11: No DPIA for AI processing, plaintext content storage, or first-party analytics | No DPIA for AI/plaintext/analytics = legal/process artifact |
| #925 | [GDPR] F2.6: Per-provider AI consent system has been removed; no per-user record that prompts leave | Per-provider AI consent system removed; replacement = policy/product decision |
| #914 | [GDPR] F-17-3b-1: Legal-obligation retention documented in code but lacks written policy and window | Legal-obligation retention in code but no written policy doc = policy artifact |
| #774 | Discovery: Data Migration from Shared to Isolated | Discovery: data migration shared->isolated; planning artifact; no deliverable yet |
| #773 | Discovery: AI Sandbox with Full Database Access | Discovery: AI sandbox with DB access; research; no design doc yet |
| #772 | Discovery: Multi-tenant Infrastructure Isolation Architecture | Discovery: multi-tenant infra isolation; research; no design doc yet |
| #594 | [Epic] Password Deprecation | Password Deprecation epic; passkeys/magic-link done but migration(#583)/comms(#585) unstarted |
| #590 | [Epic] Organizations | Organizations epic; zero org tables; all children open; deliberate future work |
| #589 | [Epic] Enterprise SSO | Enterprise SSO epic; depends on Orgs (no org tables); deliberate future work |
| #585 | [Deprecation] Communication | Password-deprecation comms; tech migration done, comms campaign not built (decision) |
| #583 | [Deprecation] Migration tooling | Password migration tooling; system already passwordless; admin dashboard not built (decision) |
| #582 | [Orgs] Billing | Org Billing; child of #590; deliberate future work |
| #581 | [Orgs] Guardrails | Org Guardrails; child of #590; deliberate future work |
| #545 | [Compliance] DSAR controls | Retention durations hardcoded; no published retention policy doc = legal artifact |

## 3. Still valid — confirmed open bugs/gaps (87)

The described problem still exists in current code. Verified backlog; offending location cited.

| # | Title | Offending code / what's missing |
|---|-------|--------------------------------|
| #1491 | Agent code execution: relocate @fly/sprites driver to a Node>=24 runtime | sandbox-tools-runtime.ts:64-74 Node guard still present; @fly/sprites not relocated to Node>=24 runtime |
| #1452 | Make builtin provider config authoritative at the shared read path (remove lazy-refresh staleness) | refreshBuiltinProviders lazy-only on GET; other consumers still read stale DB provider config |
| #1450 | Agents-in-other-drives: follow-ups (global override, tool sweep, drive-context, live user-binding) | Agents-in-other-drives follow-ups unimplemented (global override, tool sweep, drive-context, live binding) |
| #1425 | refactor(roles): make updateDriveRole JSONB mutations atomic | drive-role-service.ts:230-268 read-modify-write JSONB mutations non-atomic; concurrent race persists |
| #1393 | refactor(auth): eliminate barrel index.ts — direct imports per module | auth/index.ts barrel still present (~18KB); not split into session/device/mcp; ~30 routes import barrel |
| #1217 | tech-debt(messaging): unify validate+insert into transactional repository for DM and channel POST | messages/[conversationId]/route.ts:278-314 validate-then-insert; no transactional repository helper |
| #1207 | bug(agents): AI agent reports missing web search access despite tools menu showing web is enabled | web_search runtime-toggled for user chat only (chat/route.ts); agents not informed of availability via config |
| #1204 | bug(agents): AI agent cannot edit files in drive it was added to | agent-permissions.ts grants canEdit but tool execution paths don't enforce drive-membership gating on driveTools |
| #1201 | enhancement(chat): resizable chat sidebar | No resizable chat sidebar; fixed SIDEBAR_WIDTH constants, no drag/resize handlers |
| #1181 | ai-chat: same-user multi-device can't stop a stream they originated from another device | isOwnStream.ts:7-10 checks only browserSessionId, not userId; same-user multi-device can't stop stream |
| #1180 | ai-chat: bubbles synthesized from completed remote streams render without a timestamp | synthesizeAssistantMessage.ts:13-20 returns id/role/parts, no createdAt -> synthesized bubbles lack timestamp |
| #1178 | ai-chat: kick handler doesn't abort in-flight AI streams or clear pending-streams store | kick-handler.ts:121-187 emits access_revoked but never clearPageStreams/abort -> in-flight streams not aborted |
| #1055 | ai: no single source of truth for AI tool count / registry | No programmatic TOOL_REGISTRY export; tool counts hand-maintained and drifting (CLAUDE.md vs getting-started) |
| #1054 | auth: socket tokens bypass the unified ps_* token model | socket_tokens (auth.ts schema) outside unified ps_* token model; opaque-tokens.ts TokenType lacks 'sock' |
| #1050 | Remove deprecated password enum values + rate-limit config | Active enums/config removed but password event-type strings remain in test fixtures (chain-verifier tests) |
| #989 | security: /health exposes raw SIEM webhook error bodies unauthenticated | siem-adapter.ts:337 + siem-health-builder.ts:95 raw webhook body unsanitized on unauth /health |
| #985 | [GDPR] Art 17 pseudonymization helpers for append-only audit tables (activity_logs, security_audit_log) | pseudonymize*ForUser() helpers do not exist; Art 17(3)(b) pseudonymization path missing |
| #984 | [GDPR] activity_logs hot→cold tiering writer (isArchived flip job) | monitoring.ts:367 isArchived exists but no cron flips it; hot->cold writer missing |
| #980 | [GDPR] S4:F16: Audit/activity log schema lacks Art 30 record-of-processing fields (data category, re | monitoring.ts:327-405 lacks Art 30 record-of-processing fields (dataCategory/recipient) |
| #978 | [GDPR] S4:F14: Audit log hash-chain verifier exists but is not automatically run or alerted on | cron verify-audit-chain calls verifyAndAlert but setChainAlertHandler never registered -> no alert fires |
| #977 | [GDPR] S4:F13: Monitoring/anomaly detection/alerting all absent; rate limiter is in-process Map | rate-limit-utils.ts in-process Map; no monitoring/anomaly-detection/alerting wired |
| #975 | [GDPR] S4:F11: Error reporting pipeline absent — no Sentry or equivalent wired; silent failures | apps/web has Sentry but apps/processor has no error-reporting pipeline |
| #974 | [GDPR] S4:F10: AI chat retention and analytics — prompts persisted beyond operational need | conversations/messages lack expiresAt; AI chat prompts retained beyond operational need |
| #973 | [GDPR] S4:F9: Processor workers retain extracted document text indefinitely on disk unencrypted | text-extractor.ts:58 extracted text to S3 without app-layer encryption |
| #972 | [GDPR] S4:F8: Realtime broadcast endpoint trusts caller rather than audience authorization | realtime broadcast verifies caller signature but no audience-authorization check (index.ts:430-446) |
| #971 | [GDPR] S4:F7: Search index PII test only static-checks query literal — no runtime enforcement | search gdpr-audit-compliance.test.ts:24-32 static-only check; no runtime PII enforcement in search route |
| #969 | [GDPR] S4:F5: Encryption in transit gaps — HSTS gated on isProduction, internal traffic plaintext, n | security-headers.ts:127-131 HSTS gated on isProduction; internal traffic plaintext |
| #967 | [GDPR] S4:F3: CLAUDE.md mentions bcryptjs but auth is passwordless; stale doc only | CLAUDE.md clean, but bcrypt still referenced in tenant task-planning docs; doc cleanup partial |
| #966 | [GDPR] S4:F2: File storage at rest is unencrypted; cloud relies entirely on infra disk encryption | content-store.ts:286-291 S3 PutObject; file storage at rest no app-layer encryption |
| #965 | [GDPR] S4:F1: No application-layer encryption for general PII columns (email, name, IP, content) | encryption-utils exists but not applied to PII columns (email/name/IP/content stored plaintext) |
| #960 | [GDPR] F3.20: Google Calendar and GitHub backend routes not deployment-mode gated | google-calendar disconnect doesn't delete cached events; GitHub routes nonexistent (partial) |
| #959 | [GDPR] F3.19: Google Calendar cached data survives after disconnect | google-calendar/disconnect/route.ts:68-78 clears tokens but not cached calendarEvents |
| #955 | [GDPR] F3.15: US processing declared but no Art 46 transfer mechanism named | privacy/page.tsx:191-195 declares US processing but names no Art 46 mechanism |
| #954 | [GDPR] F3.14: Unrestricted operator access; admin DSAR reads are unaudited | Admin DSAR export audited but operator access scope still unrestricted |
| #950 | [GDPR] F3.10: No subprocessor disclosure or change-notification mechanism | privacy/page.tsx:114-126 no subprocessor list / change-notification mechanism |
| #949 | [GDPR] F3.9: No Art 28 DPA inventory exists in repo, deploy repo, or legal pages | No Art 28 DPA register anywhere in repo/deploy/legal pages |
| #947 | [GDPR] F3.7: Apple APNs carries notification title and body to US infrastructure | push-notifications.ts:149-151 APNs title/body to US infra; no Art 46 disclosure |
| #946 | [GDPR] F3.6: GitHub integration has no DPA reference; repo scope is full-access | integrations/providers/github.ts:22 full-access scopes; no DPA reference |
| #945 | [GDPR] F3.5: Google OAuth/Calendar integration has no DPA reference; Calendar scope broad | oauth-utils.ts:20-72 Google OAuth/Calendar; no DPA reference; broad scope |
| #943 | [GDPR] F3.3: Stripe transfers with no SCC or DPA reference in repo or legal pages | stripe-customer.ts:49-53 Stripe transfer; no SCC/DPA reference |
| #940 | [GDPR] F2.21: Google Identity Services third-party script loaded without prior consent | GoogleOneTap.tsx:238-249 GIS script loads without prior-consent banner |
| #939 | [GDPR] F2.20: Onprem mode disables signup but not analytics tracker; consent surface is mode-agnosti | ClientTrackingProvider unconditional in layout.tsx:160; analytics not mode-gated |
| #938 | [GDPR] F2.19: No per-category retention period stated; policy says only reasonable timeframe | privacy/page.tsx:174-185 no per-category retention periods stated |
| #937 | [GDPR] F2.18: No Cookie Policy document; cookies referenced only obliquely in Security section | No Cookie Policy document; cookies only obliquely referenced |
| #936 | [GDPR] F2.17: Controller identity not named in Privacy Policy; Terms names sole proprietor without a | terms/page.tsx:211 sole proprietor no full address; controller identity not named in privacy |
| #934 | [GDPR] F2.15: Automated decision-making position not stated; policy silent on absence of Art 22 proc | Privacy policy silent on Art 22 automated-decision-making position |
| #933 | [GDPR] F2.14: Stripe checkout shows no in-flow Art 13 notice; relies on privacy-policy link only | Stripe checkout shows no in-flow Art 13 notice (privacy-link only) |
| #932 | [GDPR] F2.13: Transactional emails default-on; first-touch invites lack Art 14 notice to non-users | email-notifications.ts:8-18 default-on; invite email lacks Art 14 notice to non-users |
| #929 | [GDPR] F2.10: No DPO designated, no Art 27 EU representative, no controller postal address | privacy/page.tsx:217-225 no DPO/EU-rep/controller postal address |
| #928 | [GDPR] F2.9: Cross-border transfers rest on user consent only; no SCCs, BCRs, or adequacy reference | privacy/page.tsx:148-156 DSR section omits Art 18/21/7(3)/13(2)(d) |
| #927 | [GDPR] F2.8: Data subject rights section is materially incomplete; omits Art 18, 21, 7(3), 13(2)(d) | Privacy policy never states Art 6 lawful basis for processing |
| #926 | [GDPR] F2.7: Privacy policy never states a lawful basis under Art 6 for any processing purpose | client-tracker.ts:227-254 first-party analytics fires without opt-in/Art 13 notice |
| #924 | [GDPR] F2.5: First-party analytics tracker fires on every page including unauth; no opt-in or Art 13 | No cookie banner/consent UI; preference cookies set without consent gate |
| #923 | [GDPR] F2.4: No cookie banner or consent UI; preference cookies set without consent gate | auth.ts:10-43 no DOB/age field; no Art 8 age verification |
| #922 | [GDPR] F2.3: No age verification anywhere; privacy policy mentions only under-13 (COPPA), not Art 8' | GoogleOneTap.tsx:32 autoSelect=true submits before notice can be read |
| #921 | [GDPR] F2.2: Google One Tap submits credentials before user can read any notice; autoSelect=true | GoogleOneTap.tsx:205-220 autoSelect=true credential auto-submit before notice (rel. #922) |
| #919 | [GDPR] F-12-3-1: No 30-day SLA tracking or data_subject_requests table to evidence compliance | No data_subject_requests table; no 30-day SLA tracking |
| #918 | [GDPR] F-5e-2: Retention windows hardcoded in route handlers — tenant deployments cannot configure | purge-ai-usage-logs/route.ts:21 hardcodes 90 days; not env-configurable per tenant |
| #917 | [GDPR] F-5e-1: High-volume tables (activity_logs, error_logs, security_audit_log) have no retention | activity_logs table has no retention cleanup (distinct from activityLogs/userActivities) |
| #916 | [GDPR] F-20-2: No standard-format export (DTIF, Solid); custom JSON only | account/export/route.ts:76-89 custom JSON only; no DTIF/Solid standard format |
| #915 | [GDPR] F-20-1: Export format ZIP+JSON has no manifest or schema documentation inside | account/export/route.ts:76-89 ZIP+JSON has no manifest/schema documentation |
| #913 | [GDPR] F-17-2-4: Email provider suppression list not synced on user delete | account/route.ts:329-336 no email-provider suppression-list sync on delete |
| #912 | [GDPR] F-17-2-3: AI provider data not deleted or forwarded on erasure — no ZDR/deletion API wired | account/route.ts:315 only local logs deleted; no AI-provider deletion/ZDR wired |
| #908 | [GDPR] F-17-4: Multi-member drive blocker has no escalation path or force-delete; hard-blocks with H | account/route.ts:246-254 multi-member drive hard-blocks 400; no escalation/force-delete |
| #906 | [GDPR] F-17-2: No async/retry/completion path for erasure — single HTTP request with no queue or SLA | account/route.ts:193-377 synchronous erasure; no queue/retry/SLA |
| #904 | [GDPR] F-15-4: No rate limit or abuse control on admin export endpoint | admin export route never calls checkRateLimit(); EXPORT_DATA config unused |
| #890 | Externalize security audit logs and application logging | SIEM delivery schema defined but external audit-log externalization not built (epic) |
| #860 | On-prem: implement local passkey auth to replace password login | setup-onprem-admin.ts:116 tells user to register passkey but no on-prem passkey flow exists; magic-link only |
| #675 | [Landing] Rollback & AI Undo section | Marketing Rollback/AI-Undo landing section component missing (feature built; marketing section not) |
| #627 | [QA] Task 39: Documentation | Integration documentation (changelog/admin/user/dev/API) not created |
| #626 | [QA] Task 38: Security audit | Integration security audit not conducted/documented |
| #625 | [QA] Task 37: End-to-end integration tests | E2E integration tests absent (no e2e/integrations.spec.ts) |
| #593 | [Epic] Data Compliance | Data Compliance epic; #545 DSAR still open; log governance/erasure pending |
| #592 | [Epic] Monitoring | Monitoring epic; #540 retention policy still open; expiresAt present, no enforcement |
| #591 | [Epic] Audit Logging | Audit Logging epic; children #972/#978/#918/#917 still open after verification |
| #580 | [Orgs] Drive ownership | No orgId on drives; org-owned drives not implemented |
| #579 | [Orgs] Membership | No /api/orgs routes, no orgMembers table; membership API absent |
| #578 | [Orgs] Schema | Schema missing organizations/orgMembers/orgId |
| #577 | [SSO] Enforcement | No SSO enforcement toggle/logic |
| #576 | [SSO] Domain routing | No domain-routing on login; no ssoConnections table |
| #575 | [SSO] Configuration UI | No org SSO settings UI |
| #574 | [SSO] OIDC | No OIDC routes/lib |
| #573 | [SSO] SAML 2.0 | No SAML routes; authProvider enum lacks SAML/OIDC |
| #541 | [Audit] Hash-chain GDPR fix | activity-log anonymization leaves resourceTitle (may contain email) unscrubbed |
| #540 | [Monitoring] Retention policy | system_logs/api_metrics lack expiresAt; retention hardcoded; no governance matrix |
| #515 | [Feature] Hide page from AI / Hide page from human | core.ts has visibleToGlobalAssistant/excludeFromSearch but no hideFromHuman column; feature not built |
| #434 | Tech debt: Finish push notifications path (unused hook and platform gaps) | push-notifications.ts:352-366 Android FCM + Web VAPID stubbed 'not yet implemented'; only iOS APNs works |

