# Code Review — `pu/pane-agent-selector-followup` (PR #2278)

Reviewed 2026-07-30 against `origin/master` (merge-base `e672903788e87ad64b1204aea2b7fe7fa6e5dd10`, the
merge commit for #2276). 2 files changed, 121 insertions / 17 deletions, both in
`apps/web/src/components/agents/panes/`.

Scope: a narrow follow-up to PR #2276 (restore the per-pane agent selector). #2276 merged before its
Codex review finished; both findings it raised were real, so they land here instead of a push to the
already-merged branch.

Gates run locally, all green:
- `bun run typecheck` (apps/web, `tsc --noEmit` — clean `.next/types` rebuild) ✅
- `bun run lint` (apps/web) ✅ — only pre-existing warnings in unrelated files
- `bun x vitest run` on `select-pane-agent.test.ts`, `AISelector.test.tsx`, `AgentPanes.test.tsx` — 38/38 ✅
- `bun run knip:check` ✅ within baseline

The PageSpace board was not consulted for this review: `pagespace whoami` resolves to an unrelated
project's drive set (per this session's own working context — the `pagespace-cli` companion tool,
not this webapp), and no page in this repo's own board was named as the target. Findings are recorded
here per the review skill's no-board fallback, matching this repo's existing convention
(`pu-machine-pane-fixes.md`, `pu-activity-log-fk.md`).

## What changed and why

Two staleness races in the pane bar selector's switch decision (`selectPaneAgent`, unchanged — the
data feeding it was the bug):

1. **Cold-mount race** (Codex, [#2276 discussion_r3683989069](https://github.com/2witstudios/PageSpace/pull/2276#discussion_r3683989069)):
   before the session's conversation list (`sessionConversations`, SWR-backed) loads even once, it
   reads as `[]` — indistinguishable from "no thread yet." If the agent-picker's OWN list
   (`pickableAgents`, a separate faster fetch) was already warm, a user could switch agents before the
   conversation list caught up, and picking an agent that already had a thread would wrongly `mint` a
   duplicate. Fixed: `sessionConversationsLoading` (SWR's own `isLoading`) folds into the selector's
   existing `disabled` condition.
2. **Post-mint staleness** (Codex, [#2276 discussion_r3683989078](https://github.com/2witstudios/PageSpace/pull/2276#discussion_r3683989078)):
   a successful mint wrote straight into the pane store, but `sessionConversations` only caught up on
   its next 20s SWR poll. Switching away from the freshly-minted agent and back within that window
   re-ran the decision against a list that still didn't know the mint happened — a second mint. Fixed:
   `recordMintedConversation` writes the new row into the SWR cache locally (`mutate(fn, {revalidate:
   false})`) right after a successful mint, correctly reconciled by the next real poll rather than
   racing it.

## Findings

- [x] **nit** · `AgentPanes.tsx:332-333` (verified, no code change needed) · Confirmed
  `recordMintedConversation` is called ONLY after the `paneStillExists` early-return for a pane closed
  mid-mint — an orphaned mint (cleaned up server-side via `cleanupOrphanedConversation`) is correctly
  never recorded into `sessionConversations`. Traced the exact statement order to rule out a
  false-positive record of a conversation about to be deleted.
- [x] **nit** · concurrent-mint composition (verified, no code change needed) · `mutateSessionConversations`
  uses a functional updater (`(current) => {...}`), which SWR serializes against its own cache rather
  than a stale closure — two mints from different panes in the same session in quick succession both
  land, neither overwrites the other. No test added (would require reaching into SWR's internal
  mutate queue to observe ordering); reasoned through the SWR contract instead.
- [ ] **minor, not actioned** · test coverage gap · No test exercises `recordMintedConversation` for a
  `null` (Global Assistant) `agentPageId` specifically — the function is parameterized identically for
  both cases and the existing agent-2 test exercises the same code path, so this is symmetric-logic
  coverage rather than a distinct branch. Left out of scope for this narrowly-targeted fix; flagging so
  it isn't silently forgotten if `recordMintedConversation` ever grows agent-specific branching.
- [ ] **not a defect** · perpetual-disable-on-hang · If the `/api/agent-sessions` fetch never settles
  (a true network hang, no timeout anywhere in this stack), `sessionConversationsLoading` stays `true`
  forever and the selector never enables. This matches the existing, unrelated `agentsLoading` gate on
  `PanePicker` (same shape, same lack of a timeout) — not a regression this PR introduces, and there is
  no established timeout convention elsewhere in this codebase to diverge toward. No action.

**Verdict: 0 blockers / 0 majors / 0 minors actioned / 1 minor noted-not-actioned / 2 nits verified.**
Both Codex findings from #2276 are correctly and narrowly fixed, with a regression test per fix that
would fail on a revert (traced by hand: removing `recordMintedConversation`'s call site makes the new
switch-back-then-forward test fail on `mockPost` call count). No security-relevant surface touched
(client-side SWR cache + a disabled boolean; no new network requests, no auth/permission code, no user
input handling). Merge-ready.
