# Code Review — `pu/machine-pane-fixes`

Reviewed 2026-07-22 against `master` (merge-base `a9711406e`). 41 commits; ~6,046 added / 412 removed
lines of non-test source across 53 files (plus ~7k lines of tests and three Drizzle migrations).

Scope: the machine-node cascade (`MachineNodeHandleSet`), the session family
(`list/add/move/kill/read/send_session`), the headless dispatch engine, lazy project-Sprite promotion
(issue #2204 phase 7), and branch/project storage attribution.

Gates run locally, all green:
- `bun run typecheck` ✅ · `bun run lint` ✅
- `bun test` on the new lib suites (promotion, pane-binding, storage-reconcile, project-session) —
  **92 pass / 0 fail**
- `vitest run` on the web session family (session-tools, session-layout, session-io-pty,
  session-io-agent, headless-session-run, tool-filtering, actor-permissions) — **166 pass / 0 fail**

Every finding below is therefore a gap in what the tests *assert*, not a failing test.

The PageSpace epic board could **not** be consulted (`pagespace whoami` → "Not logged in"), so
plan-adherence was assessed against the code and commit history only. Findings are recorded here per
the review skill's no-board fallback.

## Findings

- [ ] **blocker** · `packages/lib/src/services/machines/machine-projects.ts:291` · A promoted project's
  Sprite is never destroyed on any teardown path, leaving a live billing microVM with no row pointing at
  it · `removeProject` deletes the `machine_projects` row without killing the project Sprite;
  `0209_sprite_reclaim_triggers.sql` installs `AFTER DELETE` triggers only on `machine_sessions` and
  `machine_branches`, so the reclaim outbox never sees it; `teardownMachineSprites`
  (`apps/web/src/lib/machines/machine-settings-runtime.ts:350-415`) stamps `teardownRequestedAt` and
  kills only those same two tables; and `machine-orphan-reconcile-runtime.ts:95-140` queries only those
  two tables for tier-2 candidates. This is exactly the production incident
  `machine-orphan-reconcile.ts`'s module doc was written for, and it is worse than the branch case
  because once the row is deleted `listProjectSprites` stops billing it, so the leak is also invisible.
  Correct: add the `AFTER DELETE` trigger on `machine_projects`, extend `teardownMachineSprites` to
  stamp + kill promoted project Sprites (identity-guarded CAS on `spriteInstanceId`, stamping
  `spriteTornDownAt` rather than deleting the row), and add the project row source to the orphan
  reconciler's tier-2 candidate query.

- [ ] **major** · `apps/web/src/lib/ai/machines/headless-session-run-runtime.ts:314` · The headless
  dispatch engine runs a full agent loop with no AI credit gate · `apps/web/src/app/api/ai/chat/route.ts:628`
  calls `canConsumeAI` and holds credit before generating; `generate()` here only meters after the fact
  via `trackUsage`. A user at or over their limit can drive unbounded turns — and depth-2 chains — through
  `send_session` and `add_session.prompt`. Correct: gate the dispatch on the same `canConsumeAI` check
  (before `claimRun`, so a refusal leaves no message in the transcript) and settle the hold in
  `runClaimedTurn`'s `trackUsage` step.

- [ ] **major** · `apps/web/src/lib/ai/machines/headless-session-run-runtime.ts:339` · The headless run
  composes tools with `filterToolsForMachineBinding` + `withSessionFamilyTools` but never applies the
  page's saved allowlist · `chat/route.ts:933` applies `filterToolsForAgentAllowlist(..., page.enabledTools)`;
  the headless path does not, so a machine page configured to restrict its tool surface gets the *full*
  surface the moment it is reached via `send_session` instead of interactively. Correct: read the machine
  page's `enabledTools` in `generate()` and pipe the composed set through
  `filterToolsForAgentAllowlist` exactly as the route does.

- [ ] **major** · `packages/lib/src/services/machines/machine-project-promotion.ts:466` · Promotion
  `rm -rf`s the machine-side checkout but never clears or updates `machine_projects.path`, leaving the
  column pointing at a directory that no longer exists · `projectHandle`
  (`packages/lib/src/services/machines/machine-pane-binding.ts`) falls back to `cwd: project.path` for
  any promoted project whose `spriteTornDownAt` is set, so a torn-down promoted project silently binds
  tools to a reclaimed path; `removeProject` likewise `rm -rf`s that dead path while the project's real
  data survives on its own Sprite. Correct: either null `path` on promotion and make the torn-down
  fallback an explicit refusal (mirroring the branch path's `branch_not_found`), or re-materialize the
  checkout before falling back.

- [ ] **major** · `apps/web/src/lib/ai/tools/actor-permissions.ts:40,89` · Adding the `PageType.AI_CHAT`
  gate makes *every* non-agent page chat fall through to the invoking user's full reach, not just machine
  panes · previously a non-agent `agentPageId` was fail-closed (no `driveAgentMembers` row could exist,
  so `getAgentAccessLevel` denied); now `resolveActingAgentId` returns `undefined` and tools act with the
  user's whole cross-drive ACL. The commit's rationale is specifically about machine panes, but the
  change is unconditional. Correct: confirm no page type other than a Machine page reaches
  `chatSource.type: 'page'` with `agentPageId = chatId`, and if others can, scope the fall-through to
  machine pages rather than to "not AI_CHAT".

- [ ] **minor** · `apps/web/src/lib/ai/core/tool-filtering.ts:313` · `filterToolsForAgentAllowlist`
  exempts `SESSION_FAMILY_TOOL_NAMES` unconditionally, so an operator can never restrict
  `kill_session`/`send_session` on a bound page · defensible today (the family is registered by addition
  and so never appears in the agent-config listing), but the exemption becomes a silent no-op toggle the
  moment those names are surfaced in the UI. Correct: leave as-is with a note, or gate the exemption on
  "the allowlist predates the family" rather than on the tool name.

- [ ] **minor** · `apps/realtime/src/index.ts:774,801` · `/api/session-read` and `/api/session-input`
  accumulate the request body into a string with no byte cap before the HMAC check runs · an unauthenticated
  caller can stream an arbitrarily large body and hold memory until the signature is finally rejected.
  Consistent with the pre-existing `/api/broadcast` handlers, so not a regression, but this doubles the
  surface. Correct: cap accumulated bytes and `destroy()` the request past the limit, ideally in one
  shared body reader for all five endpoints.

- [ ] **minor** · `packages/lib/src/services/machines/machine-pane-binding.ts:250-260` ·
  `deriveMachinePaneBinding` at machine root issues 1 + N queries (project list, then one branch list per
  project) on every bound chat request · fine at today's project counts, but it is on the hot path of
  every machine-pane turn. Correct: one joined read of projects + live branches.

- [ ] **minor** · `packages/lib/src/services/machines/machine-pane-binding.ts:31` · Importing
  `PROJECT_REPO_PATH` from `machine-project-promotion.ts` drags the whole promotion graph (git runners,
  sandbox client, machine-host adapter) into the binding module for one string constant · the same
  pattern already exists for `BRANCH_REPO_PATH`. Correct: move both constants beside `SANDBOX_ROOT` in
  `services/sandbox/sandbox-paths.ts`.

- [ ] **minor** · `apps/web/src/lib/ai/machines/headless-session-run-runtime.ts:303,372` ·
  `buildSystemPrompt(target, basePrompt, timezone)` is only ever called with two arguments, so
  `buildTimestampSystemPrompt(undefined)` always renders the fallback timezone for every dispatched run ·
  a dispatched agent's sense of "now" silently differs from the same session's interactive turns. Correct:
  thread the dispatcher's timezone through `HeadlessDispatchInput`, or drop the parameter.

- [ ] **nit** · `apps/web/src/lib/ai/tools/sandbox-git/generate-tools.ts:68` · `withNodeTarget` silently
  returns the schema unchanged when `row.schema` is not a `ZodObject`, so a git row added later with a
  wrapped schema loses `target` addressing with no signal · Correct: throw at factory construction time
  for a row whose schema cannot carry `target`.

- [ ] **nit** · `apps/web/src/lib/ai/core/types.ts:124` · File still ends without a trailing newline
  (`\ No newline at end of file` in the diff) · add one.

- [ ] **nit** · `apps/web/src/hooks/useMachineWorkspaceSync.ts:30-40` · Residual race (1) — a second
  hook instance's stale full-replace hydrate can drop a just-created workspace until reload — is
  documented as "tracked as a follow-up" but no issue reference is given · Correct: link the tracking
  issue in the comment so the accepted race stays accountable.

## What is good

The authorization story is genuinely well-built: `MachineNodeHandleSet` makes sibling isolation a
property of derivation rather than a rule anyone can forget, and both consumers (`isMachineAccessible`,
`resolveMachineNodeTarget`) read the same set, with the "one policy site" invariant restated at every
seam. `promoteProject`'s dirty-tree refusal, the CAS-with-collision-reconcile, and the kill-on-persist-
failure path are careful in exactly the places that would otherwise orphan a VM. The pure-core /
runtime split (`session-tools` vs `session-tools-runtime`, `headless-session-run` vs its runtime) keeps
the whole family unit-testable without a DB, and the tests follow it. Storage attribution correctly
separates measurement subject from payer key in one place. No `any`, typecheck and lint clean, commit
messages conventional and informative.

## Verdict

**1 blocker / 4 majors / 4 minors / 3 nits.** Do not merge until the promoted-project Sprite reclaim
path (blocker) exists — it leaks live billable VMs on the ordinary "remove project" and "delete machine"
flows. The two headless-path gaps (credit gate, tool allowlist) are the next priority: both are cases
where a control enforced on the interactive path is simply absent on the dispatched one.
