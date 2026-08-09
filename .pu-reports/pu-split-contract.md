# Split `contract.ts` by concern

Branch `pu/split-contract`, base `pu/workspace-node-model` (`801d2d739`).

Acts on `.pu-reports/audit-simplicity.md` Pass 5: one module held three unrelated
concerns, which made the old layout model's deletion look like a 26-file change.
Splitting it separates the keepers from what actually dies.

## What moved where

`packages/lib/src/agent-workspaces/contract.ts` (445 lines, 43 exported symbols)
became three modules. **All 43 exports survive; none were added.**

### `shells-contract.ts` — 26 symbols (new file)

Shells and the shell bridge. Never layout; outlives the old model.

`SHELL_AGENT_TYPES`, `shellAgentTypeSchema`, `ShellAgentType`, `shellDtoSchema`,
`ShellDTO`, `MIN_COLS`, `MIN_ROWS`, `MAX_COLS`, `MAX_ROWS`,
`clampShellDimensions`, `shellConnectPayloadSchema`, `ShellConnectPayload`,
`SHELL_BRIDGE_ROUTES`, `ShellBridgeRoute`, `MAX_SHELLS_PER_READ`,
`MAX_SHELL_INPUT_BYTES`, `MAX_SCROLLBACK_TAIL_LINES`, `shellStartRequestSchema`,
`ShellStartRequest`, `shellReadPayloadSchema`, `ShellReadPayload`,
`ShellReadEntry`, `ShellReadResult`, `shellSendPayloadSchema`,
`ShellSendPayload`, `ShellSendResult`

The task's table listed 7 shell symbols; the module also carried the whole
shell-bridge wire surface (`shellReadPayloadSchema` and friends), which is the
same concern and moved with it.

### `session-contract.ts` — 6 symbols (new file)

Session identity and sandbox lifecycle. Also a keeper.

`MAX_ACTIVE_WORKSPACES_PER_OWNER`, `SANDBOX_STATUSES`, `sandboxStatusSchema`,
`SandboxStatus`, `agentSessionDtoSchema`, `AgentSessionDTO`

### `contract.ts` — 11 symbols (remnant, stays put)

The old layout model's wire shape, and nothing else.

`PANE_KINDS`, `paneKindSchema`, `PaneKind`, `paneScopeSchema`, `PaneScope`,
`persistedPaneStateSchema`, `PersistedPaneState`, `persistedColumnStateSchema`,
`PersistedColumnState`, `persistedWorkspaceStateSchema`,
`PersistedWorkspaceState`

Its docblock now opens by saying plainly that what remains is the old layout
model's wire shape, scheduled for deletion with that model, and points at the two
modules that moved out.

## Importer counts

| Module | Importers | non-test | test |
|---|---|---|---|
| `shells-contract.ts` | 18 | 11 | 7 |
| `session-contract.ts` | 10 | 5 | 5 |
| `contract.ts` (layout) | 10 | 5 | 5 |

Two files import from more than one of the three, so the columns total more than
the 34 files that referenced the original module.

The layout remnant's 5 non-test importers are `workspace-layout-verbs.ts`,
`workspace-layout-wire.ts`, `workspace-layout-runtime.ts`,
`authorize-pane-scope.ts`, and `session-tools.ts` — which is Pass 5's point
restated as fact: the layout model's real reach is about five files, not 26.

## Verified as a pure move, mechanically

Not by eye. Two checks against `git show HEAD:...contract.ts`:

1. **Symbol set** — exported names extracted from the old file and from the three
   new ones, sorted and diffed: 43 vs 43, empty diff both directions.
2. **Code bodies** — comments and blank lines stripped from both sides, sorted
   and diffed. The *only* lines the new set adds are two extra `import { z } from
   'zod';` (one per new file) and one duplicated `const isoTimestamp =
   z.string().datetime();`. Every other code line is byte-identical. No type,
   schema, constant or function body changed.

## Judgement calls

**`isoTimestamp` is duplicated, deliberately.** This private one-liner
(`z.string().datetime()`) was used by both `agentSessionDtoSchema` and
`shellDtoSchema`. Sharing it would mean one concern importing the other for one
line — recreating exactly the cross-concern edge this split removes. It is a
validator primitive, not a wire shape, so the module's "no shape declared twice"
rule does not reach it. Both copies carry a comment saying so. The alternative —
a third module holding one line — seemed worse.

**Module docblocks were re-homed, not rewritten.** The two semantic invariants
("a session OWNS conversations", "ids address, names label") are preserved
verbatim and now live once, in `session-contract.ts`; both other modules point at
them. Invariant 2 governs shells too, which is why it is cross-referenced rather
than split in half.

**Names.** Kept the suggested `shells-contract.ts` / `session-contract.ts`.
Observation, left alone: sibling shell modules use the singular (`shell-io.ts`,
`shell-types.ts`, `shell-access.ts`) and reserve the plural for collections
(`workspace-shells.ts`), so `shell-contract.ts` would match convention slightly
better. Not worth diverging from the name other tasks in this epic will reference.

## Noticed and deliberately left alone

- **`__tests__/contract.test.ts` now imports from all three modules.** Its
  imports are updated but the file was not split — splitting it would move test
  counts between files for no behavioural reason, and the task is a move. It is
  the natural follow-up when the layout model is deleted: the layout third of
  that file dies with it.
- **`FRACTION_EPSILON` / `readFraction`** in `workspace-layout-verbs.ts` — not
  touched, per the task. Still the successor depending on what it replaces.
- **Two genuinely dead exports**, unrelated to this work:
  `ConversationContentEventName` and `ConversationDirectoryEventName` in
  `packages/lib/src/realtime/conversation-event-names.ts` have no importer
  anywhere in the repo. Present identically on the base. See the knip note below.
- **`agentSessionDtoSchema.sessionId` and `shellDtoSchema.sessionId`** are both
  marked `@deprecated ROLLING-DEPLOY COMPAT, one release only`, and the comment
  says "the contract PR deletes this field". They are still here. Not mine to
  remove, but someone should decide whether that release window has passed.
- **`session-tools.ts` was clean and was updated.** Checked every worktree for
  local modifications to it before editing; none had it dirty, and the node-model
  worktree (`wt-fv4tj570`) sits on the same base commit with that file untouched.
  Its one import became three, one per concern — which is the finding made
  visible: that file really does span all three.

## Registration

- `packages/lib/package.json` — added `./agent-workspaces/session-contract` and
  `./agent-workspaces/shells-contract`, copying the existing entries' shape
  exactly (`types` / `import` / `require` → `./dist/...`). Confirmed both `.js`
  and `.d.ts` land in `dist/` after a build.
- `knip.json` — added both to `packages/lib`'s `entry` list. **This is load-bearing,
  not tidiness:** with the exports-map keys but no knip entries, knip flags
  `ShellBridgeRoute` and `ShellStartRequest` as unused types and the blocking
  ratchet fails. Verified by isolating each config edit.

## Test counts, before and after

Baseline captured on the untouched base commit before any edit.

| Check | Before | After |
|---|---|---|
| `@pagespace/lib typecheck` | pass | pass |
| `@pagespace/lib lint` | pass | pass |
| `@pagespace/lib test src/agent-workspaces` | 21 files, **682 passed** | 21 files, **682 passed** |
| `web test src/lib/agent-workspaces` | 7 failed / 11 passed (18 files); **2 failed, 162 passed, 44 skipped (208)** | 7 failed / 11 passed (18 files); **2 failed, 162 passed, 44 skipped (208)** |

Not required by the task, but run because the change touches them:

| Check | Before | After |
|---|---|---|
| `@pagespace/lib test src/services/agent-workspaces` | — | 11 files, 199 passed |
| `apps/realtime test` | — | 25 files, 961 passed |
| `apps/realtime typecheck` / `lint` | — | pass / pass |
| `web test src/lib/ai/tools src/lib/websocket` | 1 failed / 53 passed (54); 1751 passed, 22 skipped | identical |
| `web typecheck` | 3 errors | same 3 errors |

### The pre-existing failures, identified rather than waved past

The web numbers are unchanged, and the failing **set** is identical too — the 13
failing test names were diffed before against after, not just counted. They are:

- **11 integration failures**: all `could not reach Postgres` / `DATABASE_URL`.
  Environmental — no test DB in this worktree.
- **2 assertion failures** in `workspace-node-runtime.test.ts` (`expected
  'conflict' to be 'refused'`), and **3 `web typecheck` errors** in
  `agent-workspaces-runtime.ts` (`Property 'changed' does not exist on ...
  WorkspaceNodeSnapshotResponse`). These belong to the node-model rewrite in
  flight on the base branch.

I did not assume the typecheck errors were pre-existing. I checked out the base
commit into a throwaway worktree, installed, built, and ran `web typecheck`
there: the same three errors at the same three lines (306, 545, 577). Same method
for the `web test src/lib/ai/tools` failure — `activity-tools.test.ts`, failing
identically on the untouched base.

### knip

**`bun run knip:check` passes with this change** — `4 issue(s), all within
baseline (4)` — verified on a clean checkout of the base with this change applied
and `dist` built, which is what CI does.

Worth recording because it cost time: run from **this** worktree, `knip:check`
instead reports two new issues (the dead `conversation-event-names` types above).
That is an artifact of where the worktree sits, not of the change. `.pu/` is
gitignored by the parent repo (`.gitignore:183`), so a worktree under
`PageSpace/.pu/worktrees/` sits inside an ignored directory and knip's
gitignore handling resolves a different file set there. Proven by elimination:
byte-identical trees at the two paths give different answers, and the difference
survives deleting `tsconfig.tsbuildinfo`, moving `.env` aside, and a clean
`node_modules` reinstall. **Anyone running knip from a `.pu` worktree should
confirm findings from a normal checkout before chasing them.**

## Scope

No node model files (`workspace-node*.ts`) touched. No PR opened, nothing merged.
