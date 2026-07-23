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

- [x] **blocker** · `packages/lib/src/services/machines/machine-projects.ts:291` · A promoted project's
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
  **Resolved** in `3ab154cbf`: migration 0219 `AFTER DELETE` trigger on `machine_projects`, teardown arm in `teardownOneMachine`, third row source + `markProjectTornDown` in the orphan reconciler, inline identity-guarded kill in `removeProject`; real-DB integration tests cover page/drive/erasure cascades.

- [x] **major** · `apps/web/src/lib/ai/machines/headless-session-run-runtime.ts:314` · The headless
  dispatch engine runs a full agent loop with no AI credit gate · `apps/web/src/app/api/ai/chat/route.ts:628`
  calls `canConsumeAI` and holds credit before generating; `generate()` here only meters after the fact
  via `trackUsage`. A user at or over their limit can drive unbounded turns — and depth-2 chains — through
  `send_session` and `add_session.prompt`. Correct: gate the dispatch on the same `canConsumeAI` check
  (before `claimRun`, so a refusal leaves no message in the transcript) and settle the hold in
  `runClaimedTurn`'s `trackUsage` step.
  **Resolved** in `78f51e6c1`: `checkCredit`/`releaseHold` engine deps run `canConsumeAI` BEFORE the claim; hold released on every exit path; new `credit_denied` refusal.

- [x] **major** · `apps/web/src/lib/ai/machines/headless-session-run-runtime.ts:339` · The headless run
  composes tools with `filterToolsForMachineBinding` + `withSessionFamilyTools` but never applies the
  page's saved allowlist · `chat/route.ts:933` applies `filterToolsForAgentAllowlist(..., page.enabledTools)`;
  the headless path does not, so a machine page configured to restrict its tool surface gets the *full*
  surface the moment it is reached via `send_session` instead of interactively. Correct: read the machine
  page's `enabledTools` in `generate()` and pipe the composed set through
  `filterToolsForAgentAllowlist` exactly as the route does.
  **Resolved** in `78f51e6c1`: `generate()` pipes the composed set through `filterToolsForAgentAllowlist(machinePage.enabledTools)`, session family exempt for the same reason as the route.

- [x] **major** · `packages/lib/src/services/machines/machine-project-promotion.ts:466` · Promotion
  `rm -rf`s the machine-side checkout but never clears or updates `machine_projects.path`, leaving the
  column pointing at a directory that no longer exists · `projectHandle`
  (`packages/lib/src/services/machines/machine-pane-binding.ts`) falls back to `cwd: project.path` for
  any promoted project whose `spriteTornDownAt` is set, so a torn-down promoted project silently binds
  tools to a reclaimed path; `removeProject` likewise `rm -rf`s that dead path while the project's real
  data survives on its own Sprite. Correct: either null `path` on promotion and make the torn-down
  fallback an explicit refusal (mirroring the branch path's `branch_not_found`), or re-materialize the
  checkout before falling back.
  **Resolved as designed** in `5e7c57ec7`'s follow-ups: the node deliberately STAYS in the handle set (set membership authorizes the next project-scoped spawn, which RE-promotes — pinned in agent-terminals.test.ts) and the dead-cwd window is documented at the derivation; an explicit refusal would make a torn-down project unrecoverable from a bound conversation.

- [x] **major** · `apps/web/src/lib/ai/tools/actor-permissions.ts:40,89` · Adding the `PageType.AI_CHAT`
  gate makes *every* non-agent page chat fall through to the invoking user's full reach, not just machine
  panes · previously a non-agent `agentPageId` was fail-closed (no `driveAgentMembers` row could exist,
  so `getAgentAccessLevel` denied); now `resolveActingAgentId` returns `undefined` and tools act with the
  user's whole cross-drive ACL. The commit's rationale is specifically about machine panes, but the
  change is unconditional. Correct: confirm no page type other than a Machine page reaches
  `chatSource.type: 'page'` with `agentPageId = chatId`, and if others can, scope the fall-through to
  machine pages rather than to "not AI_CHAT".
  **Confirmed + pinned**: any non-agent page type (DOCUMENT pinned in actor-permissions.test.ts) falls through to the INVOKING USER's own authority — which that user already has in any Global Assistant conversation — never to a phantom agent, never beyond the user.

- [x] **minor** · `apps/web/src/lib/ai/core/tool-filtering.ts:313` · `filterToolsForAgentAllowlist`
  exempts `SESSION_FAMILY_TOOL_NAMES` unconditionally, so an operator can never restrict
  `kill_session`/`send_session` on a bound page · defensible today (the family is registered by addition
  and so never appears in the agent-config listing), but the exemption becomes a silent no-op toggle the
  moment those names are surfaced in the UI. Correct: leave as-is with a note, or gate the exemption on
  "the allowlist predates the family" rather than on the tool name.
  **Resolved (note added)**: the caveat now lives on `filterToolsForAgentAllowlist` — if the family is ever surfaced in the config toggles, gate the exemption on allowlist age, not the tool name.

- [x] **minor** · `apps/realtime/src/index.ts:774,801` · `/api/session-read` and `/api/session-input`
  accumulate the request body into a string with no byte cap before the HMAC check runs · an unauthenticated
  caller can stream an arbitrarily large body and hold memory until the signature is finally rejected.
  Consistent with the pre-existing `/api/broadcast` handlers, so not a regression, but this doubles the
  surface. Correct: cap accumulated bytes and `destroy()` the request past the limit, ideally in one
  shared body reader for all five endpoints.
  **Resolved**: one shared `readCappedBody` (1 MiB, destroy past the cap) now fronts all five signed endpoints; covered red-first (over-cap → destroyed, no response, no emit).

- [x] **minor** · `packages/lib/src/services/machines/machine-pane-binding.ts:250-260` ·
  `deriveMachinePaneBinding` at machine root issues 1 + N queries (project list, then one branch list per
  project) on every bound chat request · fine at today's project counts, but it is on the hot path of
  every machine-pane turn. Correct: one joined read of projects + live branches.
  **Resolved**: machine-root closure is two reads total (`projectLookup.list` + new `branchLookup.listAll`), grouped in memory; pinned by a no-per-project-reads test.

- [x] **minor** · `packages/lib/src/services/machines/machine-pane-binding.ts:31` · Importing
  `PROJECT_REPO_PATH` from `machine-project-promotion.ts` drags the whole promotion graph (git runners,
  sandbox client, machine-host adapter) into the binding module for one string constant · the same
  pattern already exists for `BRANCH_REPO_PATH`. Correct: move both constants beside `SANDBOX_ROOT` in
  `services/sandbox/sandbox-paths.ts`.
  **Resolved**: both repo-path constants are defined in `services/sandbox/sandbox-paths.ts` beside `SANDBOX_ROOT`; the service modules re-export for existing callers.

- [x] **minor** · `apps/web/src/lib/ai/machines/headless-session-run-runtime.ts:303,372` ·
  `buildSystemPrompt(target, basePrompt, timezone)` is only ever called with two arguments, so
  `buildTimestampSystemPrompt(undefined)` always renders the fallback timezone for every dispatched run ·
  a dispatched agent's sense of "now" silently differs from the same session's interactive turns. Correct:
  thread the dispatcher's timezone through `HeadlessDispatchInput`, or drop the parameter.
  **Resolved**: the dead `timezone` parameter is dropped.

- [x] **nit** · `apps/web/src/lib/ai/tools/sandbox-git/generate-tools.ts:68` · `withNodeTarget` silently
  returns the schema unchanged when `row.schema` is not a `ZodObject`, so a git row added later with a
  wrapped schema loses `target` addressing with no signal · Correct: throw at factory construction time
  for a row whose schema cannot carry `target`.
  **Resolved**: `withNodeTarget` now throws at factory-construction time for a schema that cannot carry `target`.

- [x] **nit** · `apps/web/src/lib/ai/core/types.ts:124` · File still ends without a trailing newline
  (`\ No newline at end of file` in the diff) · add one.
  **Resolved**: trailing newline added.

- [x] **nit** · `apps/web/src/hooks/useMachineWorkspaceSync.ts:30-40` · Residual race (1) — a second
  hook instance's stale full-replace hydrate can drop a just-created workspace until reload — is
  documented as "tracked as a follow-up" but no issue reference is given · Correct: link the tracking
  issue in the comment so the accepted race stays accountable.
  **Resolved**: the accepted race now cites issue #2202 (entity promotion) in the comment.

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

**1 blocker / 4 majors / 4 minors / 3 nits — ALL RESOLVED** (commits `3ab154cbf`, `78f51e6c1`,
`5e7c57ec7` and follow-ups on `pu/machine-pane-fixes`). The blocker's reclaim path now exists at all
three layers (trigger / teardown / reconciler); both headless-path controls match the interactive path;
the torn-down-project fallback and the actor-permissions fall-through are confirmed by design and pinned
with tests. Original findings preserved above for the record.

---

# Code Review — second pass

Reviewed 2026-07-22 against `master` (merge-base `a9711406e`), at HEAD `acb3e680f`. This pass
re-verified the twelve first-pass findings and hunted for what the first pass missed, with particular
attention to the commits that landed *after* it (`3ad1906a6`, `8511463f0`, and the
`pu/machine-pane-actor-fix` merge).

**First-pass findings: all twelve re-verified as genuinely fixed.** The reclaim path exists at all
three layers (migration 0219's `AFTER DELETE` trigger, the `teardownOneMachine` project arm, the
reconciler's third row source + `markProjectTornDown`); the headless credit gate runs before
`claimRun` and releases the hold on every exit path; `filterToolsForAgentAllowlist` is applied on both
the interactive and headless paths; `readCappedBody` (1 MiB) fronts all five signed realtime
endpoints; the machine-root closure is two reads (`projectLookup.list` + `branchLookup.listAll`); both
repo-path constants now live in `services/sandbox/sandbox-paths.ts`; the dead `timezone` parameter is
gone; `withNodeTarget` throws at factory-construction time; `types.ts` has its trailing newline; the
accepted sync race cites issue #2202.

Gates run locally at HEAD, all green:
- `bun run typecheck` ✅ (16/16) · `bun run lint` ✅ (14/14, only pre-existing warnings)
- `vitest run` on `packages/lib` machines + sandbox — **1308 pass / 0 fail** (51 files)
- `vitest run` on the web session family, sandbox tools, promote route, workspace stores —
  **569 pass / 0 fail** (14 files)
- `vitest run` on the machine UI, sync hook, audit coverage, usage breakdown — **383 pass / 0 fail**
- `vitest run` on `apps/realtime` index + session-io + agent-terminal-access — **169 pass / 0 fail**

Two suite failures observed mid-review were traced and are NOT product defects — see
"Environment notes" below.

## Findings

- [x] **blocker** · `packages/lib/src/services/machines/machine-project-promotion.ts:473` (at
  `acb3e680f`) · A successful promotion `rm -rf`s the machine-side checkout with no re-check, so
  uncommitted work written during the provision+clone window is destroyed · the dirty-tree gate
  (`inspectMachineCheckout`) runs BEFORE `MachineHost.provision` and the full `git clone` — seconds to
  minutes — and `reclaimMachineCheckout` is then called unconditionally on `checkout.kind === 'clean'`,
  reading the *pre-clone* verdict. Its own docblock claims "CLEAN-TREE GATED by construction", which
  is true only of the stale gate. A user or a terminal session writing into the old checkout during
  that window loses the work silently. Correct: re-inspect immediately before the `rm` and skip the
  reclaim on anything but a fresh `clean` — a leftover directory is wasted bytes, deleted work is a
  loss. **Fix in flight** in the working tree (uncommitted): a `recheck` call guarding the reclaim.
  **Resolved** in `a89d235a5`: `inspectMachineCheckout` re-runs immediately before the `rm`; anything but a fresh `clean` skips the reclaim. Red-first (clean-gate → dirty-recheck → no rm).

- [x] **major** · `apps/realtime/src/terminal/session-io.ts:210` (at `acb3e680f`) ·
  `scrollbackTail`'s byte cap does not bind on a single newline-free line, so one giant line ships the
  ring's full 64 KiB into a model's context · the trim loop is
  `while (tail.length > 1 && … > MAX_SCROLLBACK_TAIL_BYTES)`, so a lone oversized element (a minified
  bundle, a base64 blob, a `curl` of a binary) exits immediately and is returned whole — 4× the
  16 KiB per-answer cap the module documents as "a per-ANSWER contract with the model's context
  window". Correct: when no line boundary is left to drop at, cut mid-line on a UTF-8 boundary keeping
  the most recent bytes, and mark the cut so it never reads as complete output. **Fix in flight** in
  the working tree (uncommitted).
  **Resolved** in `a89d235a5`: a lone over-cap line is cut mid-line on a UTF-8 boundary keeping the most recent bytes, with a leading `…` marker. Red-first; realtime branch coverage holds ≥98%.

- [x] **major** · `apps/web/src/lib/ai/machines/headless-session-run.ts:300` (at `acb3e680f`) · The
  headless run hands the model every dispatched instruction TWICE · `dispatchHeadlessSessionTurn`
  appends the dispatched message to the transcript, then `runClaimedTurn` calls `deps.loadHistory(target)`
  — which re-reads that same row — and ALSO passes `message: input.message` to `generate()`. Every
  `send_session` / `add_session.prompt` turn therefore sees its own instruction duplicated, and the
  duplicate is the most recent context. Correct: exclude the just-appended message id from the history
  read. **Fix in flight** in the working tree (uncommitted): `loadHistory(target, { excludeMessageId })`.
  **Resolved** in `a89d235a5`: `loadHistory(target, { excludeMessageId })` excludes the just-appended message (SQL `ne(id, …)`); the engine threads the appended id through. Red-first.

- [x] **major** · `apps/web/src/lib/ai/machines/headless-session-run-runtime.ts:166` (at `acb3e680f`) ·
  `claimRun`'s pre-insert liveness check and its claim INSERT are not atomic, so a human stream that
  registers between them is never yielded to · a client stream's row is keyed by its own `streamId`
  and so never collides with `session-run:<id>`'s unique index — the dispatch wins a claim the human
  already holds, and both drive the same conversation. Correct: after the claim row is visible,
  re-read the conversation's streaming rows and back off if any foreign row is still beating (only the
  dispatch side yields, so there is no livelock). **Fix in flight** in the working tree (uncommitted):
  `isClaimContested`.
  **Resolved** in `a89d235a5`: check-insert-recheck via the pure `isClaimContested` (unit-tested incl. NULL-streamId contention and self-non-contention); the dispatch deletes its own claim row and reports busy when a fresh foreign stream appeared.

- [x] **nit** · `apps/web/src/stores/machine-workspace/workspace-reducer.ts:175-184` · Two stacked
  docblocks on `projectStoredNodeScope`; the first ("Read-time projection of a STORED **pane** scope —
  the whole Phase-1 migration") describes `projectStoredPaneScope`, which sits twenty lines below with
  no doc of its own · the orphan misdescribes the function it precedes, and tooling attributes only
  the second block. Correct: move the pane-scope block down onto `projectStoredPaneScope`.
  **Resolved**: the pane-scope docblock now sits on `projectStoredPaneScope`.

## Environment notes (not findings)

- `packages/lib/src/services/machines/__tests__/machine-project-promotion.test.ts` failed twice early
  in the review and then passed 18 consecutive runs. Cause: a **stale `packages/lib/dist`** being
  rewritten by a concurrent `turbo` build — the compiled artifact predated the source under test.
  `bun run build` in `packages/lib` resolves it. Worth knowing when a lib suite fails inexplicably in
  a fresh worktree (see also the worktree-setup note in the team's env memo).
- The working tree was being **actively edited by another process during this review** (clean at
  session start; seven files modified by the end — precisely the four defects above). Findings are
  therefore recorded against the committed HEAD `acb3e680f`; the in-flight fixes are noted per finding
  and are **not yet verified or committed**.

## What is good

The post-review work holds up. Billing now records the provider/model `generate()` actually resolved
rather than the defaults, with the defaults reachable only on a path where `usage` is absent too — so
nothing is charged at the wrong rate. Both transcript reads pushed their role filters into SQL, which
is the correct fix and for the stated reason (a post-LIMIT filter lets system/tool rows eat the limit
and silently shorten context). The machine-root closure went from 1+N to two reads with the grouping
done in memory and a no-per-project-reads test pinning it. Migration 0219 is careful in the two places
that matter — `sandboxId IS NULL` means unpromoted (nothing to rescue) and a stamped `spriteTornDownAt`
means already gone (re-enqueueing a reused name could kill a replacement VM) — and matches 0209's
`SECURITY DEFINER` + pinned `search_path` precedent, including its no-snapshot convention. The
promote route is session-only, CSRF-guarded, EDIT-level, and maps each refusal to an honest status
(409 for the dirty tree the caller can fix, 503 for kill-switch/containment, 502 for provider
failures). `resolveMachineNodeTarget` refuses upward addressing and refuses an ambiguous bare branch
name rather than guessing, and the storage de-fan comments name the exact consequence of the join
fanning out (a disk billed twice). No `any`; typecheck and lint clean.

## Verdict

**1 blocker / 3 majors / 1 nit — ALL RESOLVED.** The four in-flight fixes the reviewer observed
landed as `a89d235a5` (each red-first, full gates green: lib machines+sandbox, realtime with the 98%
branch-coverage gate, web ai/machines, tsc); the docblock nit is fixed alongside this record update.
The twelve first-pass findings remain confirmed fixed. Original findings preserved above.
