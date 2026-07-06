# Sandboxes Per Drive Epic

**Status**: 📋 PLANNED
**Goal**: Scope sandboxes to drives instead of conversations/pages — one optional, tier-capped, metered machine per drive.
**Orchestration board**: PageSpace drive `pagespace` → Features → "Sandboxes Per Drive" (epic page `zz06myikksilaru5p3i3p3yi`). Each board task page is the self-contained agent prompt (spawned via read_page + /execute); this file is the canonical grounding spec those prompts cite.

## Overview

Today every AI conversation gets its own Fly Sprite (`sandbox_sessions`, keyed `tenant+drive+conversation`) and every terminal page gets another (`terminal_sessions`, keyed `tenant+drive+page`), so sandbox count grows O(conversations + terminal pages), files never persist across conversations, and unit economics are unbounded. The mental model this epic installs: **a drive is a computer**. Each drive optionally has exactly one machine; conversations, agents, and terminal pages are just different shells into it. The global assistant shells into your Home drive's machine. This mirrors canvas publishing, where a drive already owns one origin (`drives.publishSubdomain`, owner-tier-gated) — sandboxes give a drive compute the same way publishing gives it an origin, and long-term the two converge (serve a running app from the drive machine at the drive origin). Sandbox count collapses to O(enabled drives), capped by the owner's tier (free: 0, pro: ~5 — final numbers are a pricing decision), which makes sprite unit economics boundable and metering tractable. Isolation moves inward: cross-conversation file sharing becomes a *feature* (shared drive workspace), and fine-grained isolation returns later as cheap Docker containers *inside* the drive machine instead of expensive VMs per conversation. The provider stays abstracted behind the existing `sandbox-client` interface — Sprites is one driver; a cheap VPS could be another (a pricing question, not a tech one).

**Key precedents to reuse** (found in exploration, cited per task): the terminal subsystem's `persistent: true` hibernate lifecycle; `drives.publishSubdomain` / `canChooseSubdomain` for owner-tier-resolved drive resources; `maxFileCount`/`maxCustomDomains` for "N of X per tier"; the voice STT/TTS hold→settle recipe for metering a duration-unknown resource; the `credit_holds` COUNT-under-lock pattern for durable caps; `driveWidePermissions` for drive-level capability toggles.

**Decisions this epic deliberately does NOT lock in** (documented in the decision-spec tasks): exact tier counts and pricing, who-pays final policy (recommendation: drive-owner-pays, matching the subdomain precedent — "your drive, your machine, your bill"), whether Home drive counts against the cap, Sprites-vs-VPS provider mix.

**Integration model & build mandate.** All PRs target the integration branch `pu/sandboxes-per-drive` (never master); it is kept continuously up to date with master, and ONE big feature PR merges it to master at the end. Because code execution is admin-only and flag-off in prod (`CODE_EXECUTION_ENABLED` default OFF), this is a greenfield within the app — **no released consumers to protect**. Build clean: no backwards-compat shims or migration bridges (the per-conversation/per-page model is deleted, not extended); pure functions with dependency injection at the core, thin imperative shells (the `credit-core.ts`/`lifecycle.ts` split is the pattern); test-first TDD with every pure decision table-tested; small named modules. Conform to the target architecture, not the codebase's current shape.

---

## Phase: Per-drive scoping core

Hard cutover, no compat shims — `CODE_EXECUTION_ENABLED` is default-OFF and prod-gated to admins, so existing per-conversation sessions can be destroyed on deploy.

### Drive-scoped session key

Replace the per-conversation/per-page session key derivations with a single per-drive derivation.

**Requirements**:
- Given a `(tenantId, driveId)` pair, should derive one stable key `pgs-sbx-<hmac>` under a new namespace `drive-sandbox:v1`, so agent chats and terminals in the same drive address the same Sprite
- Given the old namespaces (`sandbox-session:v1`, `terminal-session:v1`), should remove them entirely — the namespace bump orphans old Sprites by construction (swept in the migration task)
- Given a missing/empty `driveId`, should refuse to derive (fail closed) — the no-drive global path is retired by the Home-drive task

**Grounding**: `packages/lib/src/services/sandbox/session-key.ts` (`deriveSessionKey`, `deriveTerminalSessionKey` — collapse to one), HMAC secret `SANDBOX_SESSION_SECRET`, 63-char Sprite-name truncation in `packages/lib/src/services/sandbox/sandbox-client/sprites.ts` (~line 576).

### drive_sandboxes schema

One row per drive machine, replacing both `sandbox_sessions` and `terminal_sessions`.

**Requirements**:
- Given a drive, should allow at most one sandbox row (unique `driveId`, FK cascade on drive delete), with `sessionKey` (unique), `tenantId`, `sandboxId`, `provisionedBy` (audit), `lastActiveAt`, timestamps
- Given the cap-enforcement task needs to count machines per owner, should make "live machine per owner" answerable with one indexed query (index on `tenantId`)
- Given schema changes, should be generated via `bun run db:generate` (never hand-write SQL in `packages/db/drizzle/`)

**Grounding**: `packages/db/src/schema/sandbox-sessions.ts`, `packages/db/src/schema/terminal-sessions.ts` (both retired), session-store module consumed by `packages/lib/src/services/sandbox/session-manager.ts` (`store.findBySessionKey`).

### Persistent drive lifecycle

One `acquireDriveSandbox` path with the terminal subsystem's hibernate semantics; conversation end no longer destroys anything.

**Requirements**:
- Given any acquire (agent turn or terminal attach), should re-authorize the current actor via `canRunCode` and plan create/resume/deny against the single drive row — `persistent: true`, idle → hibernate (never teardown)
- Given a conversation or terminal socket ending, should NOT stop the Sprite — the machine outlives every shell into it
- Given drive trash or an explicit owner "destroy" action, should confirm-stop the Sprite and only then remove the DB row (keep the no-orphans invariant: unconfirmed stop keeps the row for the reaper)
- Given the 24h hard-expiry idle reclaim, should hibernate rather than destroy, so drive workspace files survive weeks of inactivity (storage cost is handled by metering)

**Grounding**: `packages/lib/src/services/sandbox/session-manager.ts` (`acquireConversationSandbox`, `teardownConversationSandbox`), `terminal-session-manager.ts` (the `persistent: true` precedent — absorb and delete), `lifecycle.ts` (`planSandboxLifecycle`), `sandbox-client/sprites.ts` (wake retries, self-healing cwd — keep as-is).

### Agent chat routes to the drive machine

Point the AI tool context resolution at the drive sandbox and drop the conversation from the identity.

**Requirements**:
- Given a drive or page conversation, should resolve `(tenantId = drive.ownerId, driveId)` and acquire the drive sandbox — `conversationId` no longer participates in sandbox identity (keep it for audit logging only)
- Given concurrent conversations in one drive, should each run commands as independent processes on the shared machine (no serialization — it's a real computer; per-command timeouts/output caps already isolate runs)

**Grounding**: `apps/web/src/lib/ai/tools/sandbox-tools-runtime.ts` (`resolveSandboxActorContext`, lines ~196–281), `packages/lib/src/services/sandbox/tool-runners.ts`, tool registration gating in `apps/web/src/lib/ai/core/ai-tools.ts` + `complete-request-builder.ts` (unchanged).

### Global assistant uses the Home drive machine

Retire the no-drive sandbox path; the global assistant shells into the user's Home drive sandbox.

**Requirements**:
- Given a global conversation (`conversations.type = 'global'`), should resolve the user's Home drive (`drives.kind = 'HOME'`, unique per owner) and use its sandbox — `tenantId = ownerId = userId` falls out naturally, resolving the documented quota over-counting caveat in the old `tenantId=userId, driveId=''` branch
- Given a user whose Home drive is somehow absent, should deny code execution (fail closed) rather than resurrect the no-drive path — Home provisioning is the existing lazy-provision + backfill machinery's job
- Given `canRunCode`'s current `no_agent_access` denial for agent-origin runs without a driveId, should keep denying: agents always have a drive context after this phase

**Grounding**: `resolveSandboxActorContext` global branch in `sandbox-tools-runtime.ts`, `packages/lib/src/services/sandbox/can-run-code.ts` (global no-drive allowance — remove), `packages/db/src/schema/core.ts` (`driveKind`, `drives_owner_home_unique`), `packages/lib/src/services/drive-guards.ts`, `drive-service.ts` (Home provisioning).

### Terminals attach, not provision

Terminal pages become windows onto the drive machine.

**Requirements**:
- Given a terminal page opening, should acquire the drive sandbox (same key as agent chats) and open its PTY there — creating a terminal page never provisions a machine
- Given multiple terminal pages (or the same page in two tabs) in one drive, should each get an independent PTY on the shared machine
- Given the existing realtime auth chain (`canEdit` + `canRunCode`), should keep it intact — only the session acquisition changes

**Grounding**: `apps/realtime/src/index.ts` (`makeTerminalCheckAuth`, lines ~50–160, `acquireTerminalSandbox` call), `apps/realtime/src/terminal/sprites-shell.ts` (`openPtyShell`), `apps/web/src/components/layout/middle-content/page-views/terminal/TerminalView.tsx` (copy/empty-state changes live in the UI phase).

### Cutover migration and orphan sweep

Destroy the old world cleanly.

**Requirements**:
- Given deploy of this epic, should drop `sandbox_sessions`/`terminal_sessions` tables (via generated migration) and stop every Sprite whose name matches the old key namespaces — a one-shot admin sweep script, since old names are HMAC-derived and enumerable only via the Sprites API list
- Given the flag is OFF in prod and prod-gated to admins, should need no data preservation or compat window

**Grounding**: Sprites list/stop via `sandbox-client/sprites.ts`; migration via `bun run db:generate`; `feedback_no_backwards_compat_for_unreleased` convention.

---

## Phase: Optionality and tier caps

Sandboxes are opt-in per drive and counted against the drive owner's tier.

### Drive sandbox enablement setting

A drive owns whether it has a machine at all.

**Requirements**:
- Given a drive, should carry a `sandboxEnabled` boolean (default false) settable only by owner/admin via `PATCH /api/drives/[driveId]`
- Given a disabled drive, should deny acquire with a distinct reason (`sandbox_disabled`) that UI surfaces can map to "the owner hasn't enabled sandboxes here"
- Given drive trash, should destroy the machine (wired in the lifecycle task); given restore, should stay enabled but unprovisioned until next acquire

**Grounding**: `drives` table in `packages/db/src/schema/core.ts`, `apps/web/src/app/api/drives/[driveId]/route.ts` PATCH, `can-run-code.ts` (new dep), `drives.drivePrompt`/`publishSubdomain` as per-drive-config precedents.

### Tier entitlement: maxSandboxes

"N machines per owner" as a first-class plan limit.

**Requirements**:
- Given the canonical tier table, should add `maxSandboxes` (free: 0, pro: 5, founder: 5, business: TBD — placeholder constants, env-overridable, final numbers deferred to the pricing decision task) in `subscription-utils.ts`, mirrored in `plans.ts` marketing limits
- Given on-prem/tenant mode, should follow the existing override pattern (business-tier limits) even though cloud is the only shipped mode
- Given a free-tier owner, should hard-block enablement with the `PAID_TIERS` 403-upgrade response pattern (exactly how voice bars free users)

**Grounding**: `packages/lib/src/services/subscription-utils.ts` (`STORAGE_TIERS` shape, `maxFileCount` precedent), `apps/web/src/lib/subscription/plans.ts` (`PLANS`, `maxCustomDomains` precedent), `apps/web/src/lib/subscription/rate-limit-middleware.ts` (`PAID_TIERS`, `requiresProSubscription`, `createSubscriptionRequiredResponse`).

### Durable cap enforcement

The count that matters is enabled machines per owner, enforced in the DB, not in process memory.

**Requirements**:
- Given an owner enabling a sandbox on drive N+1 when their tier allows N, should reject at enable time with a COUNT of that owner's enabled drives taken under lock (the `credit_holds` COUNT-under-lock pattern — the in-memory `activeByUser` Map in `quota.ts` is per-replica and must not carry this)
- Given the owner's tier resolving the cap, should resolve via `drives.ownerId → users.subscriptionTier` (the `canChooseSubdomain` resolver pattern), NOT the acting user's tier — the machine is drive infrastructure
- Given the existing per-user run-concurrency semaphore, should keep it as-is (it limits concurrent *commands*, a different axis from machine *count*)

**Grounding**: `packages/lib/src/billing/credit-gate.ts` (COUNT-under-lock precedent), `packages/lib/src/services/sandbox/quota.ts` (leave concurrency; add nothing here), `apps/web/src/app/api/drives/[driveId]/subdomain/route.ts` (owner-tier resolver template).

---

## Phase: Metering and unit economics

Sandbox runtime becomes a metered resource through the existing credits pipeline.

### Pricing decision spec

A decision doc, not code: the sprite unit-economics model.

**Requirements**:
- Given Fly Sprites pricing (active CPU-time + hibernated storage), should produce a sandbox-seconds→cents and storage-GB→cents model with margin, proposed tier caps (validate/replace the free:0 / pro:5 placeholder), and whether Home counts against the cap — output is a table of `SANDBOX_*` constants for `credit-pricing.ts` plus a written rationale
- Given the "cheap VPS might be better for some users" question, should document the provider-mix option space (Sprites metered-by-use vs flat VPS allotment vs both) without locking it in — the `sandbox-client` interface already abstracts the driver
- Given scalable usage-billed compute is preferred, should recommend usage-billed as the default and frame flat VPS as a possible future plan add-on

**Grounding**: `packages/lib/src/billing/credit-pricing.ts` (`VOICE_HOLD_ESTIMATE_CENTS` precedent, `MARKUP_BPS`, `dailyExposureCapForTier`), Fly Sprites public pricing, `sandbox-client/sprites.ts` interface boundary.

### Runtime metering through hold→settle

Copy the voice recipe for a duration-unknown resource.

**Requirements**:
- Given a sandbox command run, should place a flat-estimate hold via `canConsumeAI(payerId, tier, { estCostCents: SANDBOX_HOLD_ESTIMATE_CENTS, maxInFlight })` before execution and settle actual cost after via `AIMonitoring.trackUsage` with a new `source: 'sandbox'`, `holdId` threaded, `releaseHold` in `finally` for no-charge paths
- Given active-time billing, should compute cost from the run's wall-clock window (Sprites hibernate when idle, so `lastActiveAt`-bounded active time is the billable quantity) through a `sandbox-pricing.ts` mirroring `voice-pricing.ts`
- Given hibernated-storage cost, should meter it separately on a periodic cron (the `reconcileStorageUsage` materialized-counter + reconcile pattern), not per-run
- Given `payerId`, should take it from the who-pays decision task (default: drive owner) — the metering plumbing must be payer-agnostic

**Grounding**: `apps/web/src/app/api/voice/transcribe/route.ts` (the recipe end-to-end), `packages/lib/src/billing/credit-gate.ts`, `credit-consume.ts`, `packages/lib/src/monitoring/ai-monitoring.ts` (`trackUsage` ~line 900), `packages/lib/src/monitoring/voice-pricing.ts`, `packages/lib/src/services/storage-limits.ts` (reconcile pattern).

---

## Phase: Member access and who-pays

Whether drive members (not just owner/admin) can use the drive machine, and whose credits burn.

### Who-pays decision spec

A decision doc resolving the one genuinely new billing shape in this epic.

**Requirements**:
- Given all existing metering is actor-pays (AI chat, voice, storage-uploader) but all per-drive published resources resolve entitlement via owner tier (subdomain, custom domains), should decide payer for member sandbox use — recommendation to evaluate first: **owner-pays** ("your drive, your machine, your bill"; opt-in = owner accepting the cost; coherent with the machine being drive infrastructure), with actor-pays documented as the fallback that matches metering precedent
- Given owner-pays, should specify the abuse story: member burns owner credits → owner's existing daily exposure cap (`dailyExposureCapForTier`) is the backstop, plus per-member visibility in the usage surface
- Given the outcome, should record it in this file and hand `payerId` semantics to the metering task

**Grounding**: exploration finding "no drive-owner-pays precedent anywhere in billing; owner-tier entitlement precedent in subdomain route", `credit-pricing.ts` daily caps, `apps/web/src/app/api/ai/chat/route.ts` (actor-pays reference).

### Member opt-in gate

Relax the owner/admin-only gate behind an explicit drive setting.

**Requirements**:
- Given a drive with `memberSandboxAccess` enabled (new drive setting, owner/admin-settable, default off), should allow accepted MEMBERs to pass `canRunCode` where today `authorizeUser` requires `isOwner || isAdmin` (`insufficient_role`)
- Given the gate relaxation, should keep every other link in the chain intact (kill-switch, prod-admin gate, agent-origin `canEdit` requirement) and stay fail-closed
- Given `driveWidePermissions` on custom roles, should note it as the eventual carrier for finer-grained "can use sandbox" role permission, but ship the boolean first

**Grounding**: `packages/lib/src/services/sandbox/can-run-code.ts` (`authorizeUser`), `packages/lib/src/permissions/permissions.ts` (`getUserDrivePermissions`), `packages/db/src/schema/members.ts` (`driveRoles.driveWidePermissions` precedent), drive setting column from the enablement task.

### Credential brokering hardening

A shared machine must not leak one member's credentials to another.

**Requirements**:
- Given per-user GitHub tokens (`resolveGitHubTokenForSandbox({userId})`) used by git tools on a now-shared VM, should inject credentials per-command (env/askpass for the single invocation) and never write them to the machine's disk or persistent env
- Given any credential-bearing tool output, should keep the existing injection-seam annotate-not-block behavior
- Given a member without a GitHub connection running git tools in a drive whose owner has one, should use the *actor's* connection or fail — never fall back to another user's token

**Grounding**: `packages/lib/src/services/sandbox/github-token.ts`, `packages/lib/src/services/sandbox/git-tool-runners.ts`, `injection-seam.ts`.

---

## Phase: UI surfaces

Grounded in the user stories; every backend setting above must be reachable and legible.

**User stories being served**: (1) Owner enables a machine for a drive and controls member access; (2) member opens a terminal and either attaches or learns why not; (3) free user hits a clean upgrade gate; (4) any user sees how many machines they own, where, and what they cost this period; (5) owner destroys/rebuilds a machine safely.

### Drive Settings → Sandbox section

The drive-level control surface.

**Requirements**:
- Given the drive settings registry, should add a "Sandbox" `SettingsItem` (Drive group, gated `canManage`) and a `sandboxes/page.tsx` following the `general/page.tsx` pattern (`useDriveStore`, SWR, shared Access Denied block, `patch('/api/drives/${driveId}')`)
- Given the page, should show: enable toggle (with tier gate → upgrade CTA for free owners, cap-reached state), machine status (none / running / hibernated), storage used, member-access toggle, who-pays line ("Usage bills to <owner>"), and a destroy/rebuild action with confirm (destructive: wipes the drive workspace)
- Given a Home drive, should show the section with sharing-related controls absent (Home is private; `homeDriveActionError` blocks invite/share anyway)

**Grounding**: `apps/web/src/app/dashboard/[driveId]/settings/page.tsx` (registry), `general/page.tsx` (page pattern), `apps/web/src/app/settings/SettingsRow.tsx`, `packages/lib/src/services/drive-guards.ts`.

### User settings: sandbox inventory and usage

The "my machines" view.

**Requirements**:
- Given `/settings/usage` (existing "Credits, usage breakdown, automations & storage" page), should add a Sandboxes block: N of maxSandboxes used, per-drive list (drive name → status → runtime cost this period), upgrade CTA when capped
- Given `source: 'sandbox'` ledger entries, should render them in the existing usage breakdown alongside AI/voice

**Grounding**: `apps/web/src/app/settings/usage/`, `apps/web/src/app/settings/page.tsx` (registry, Personal group), `credit_ledger` via existing usage queries.

### Attach and gate UX in terminals and chat

Copy and empty states that teach the model.

**Requirements**:
- Given a terminal page in a drive with no machine, should show the reason-mapped state: owner sees "Enable the sandbox for this drive" (link to drive settings), member sees "The owner hasn't enabled sandboxes here", free-tier owner sees the upgrade gate
- Given a terminal attaching, should present it as attaching to "this drive's sandbox" (not "starting a terminal") — the copy carries the mental model
- Given the AI chat sandbox tools denied with `sandbox_disabled`/`insufficient_role`/cap reasons, should surface the same mapped messages instead of an opaque failure (the `classifyProvisionError` surfacing precedent)

**Grounding**: `TerminalView.tsx`/`XtermTerminal.tsx`, realtime auth denial payloads in `apps/realtime/src/index.ts`, tool-result error surfacing in `tool-runners.ts`.

### Plan and pricing surfaces

**Requirements**:
- Given `PLANS` marketing limits, should list sandbox entitlements per tier on `/settings/plan` and any pricing page once the pricing decision task lands numbers
- Given marketing copy rules, should not name Fly/Sprites — the product noun is "sandboxes" (or "drive machines" if the mental-model naming wins; naming is part of the pricing decision doc)

**Grounding**: `apps/web/src/lib/subscription/plans.ts`, `apps/web/src/app/settings/plan/`, `feedback_marketing_copy_prose` conventions.

---

## Phase: Future scope (spec-only — documented, not built)

### Docker-in-sandbox isolation spec

**Requirements**:
- Given the drive machine as the coarse boundary, should spec running Docker inside the Sprite so per-conversation/per-task isolation returns as cheap containers inside one VM (restores today's isolation granularity at a fraction of the VM count), including whether Sprites permit nested virtualization/containerd and what the tool-runner API change looks like (`container` param on runs)

### Sandbox-serves-the-origin convergence spec

**Requirements**:
- Given a drive with both a machine and a publish origin (`publishSubdomain`/custom domains), should spec routing dynamic requests from the drive origin to a process in the drive machine — the path from static canvas publishing to "fully host your app on PageSpace"; includes wake-on-request, resource caps, and how this interacts with the containment model (`FULL-EGRESS-ENABLEMENT.md` — ingress is a new surface, currently out of scope by design)

### Provider abstraction spec

**Requirements**:
- Given the `sandbox-client` interface as the seam, should spec a second driver shape (flat-priced VPS) and the plan/config surface for choosing per drive, so the Sprites-vs-VPS question stays a pricing decision with no tech lock-in
