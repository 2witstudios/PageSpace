# The backfill's three findings — 2 (HIGH), 3 (MEDIUM-HIGH) and 5 (MEDIUM)

Base: `pu/workspace-node-model` (`ea2dfe8fe`). Branch: `pu/fix-backfill`.
Spec: `.pu-reports/sanity-verdict-2.md` findings 2, 3 and 5.

No PR opened, nothing merged, board untouched.

---

## 0. FIRST — the script the audit describes does not run

Before any of the three findings could be fixed, one thing had to be established
about the base branch, and the brief did not anticipate it:

```
$ bun -e "import('./scripts/backfill-agent-workspace-nodes.ts')"
IMPORT FAILED: ResolveMessage: Cannot find module
  '@pagespace/db/schema/agent-workspace-layout'
```

**`scripts/backfill-agent-workspace-nodes.ts` could not be imported at all on
`pu/workspace-node-model`,** let alone run. Commit `7764517cf` ("delete the model
the node tree replaced") deleted the script deliberately — its report says so in
as many words: *"I deleted `scripts/backfill-agent-workspace-nodes.ts` — it
SELECTs from all four dropped tables, so it can no longer run, and keeping it
would be a lie."* The merge `ea2dfe8fe` then resolved the delete/modify conflict
against `5e7eeb293` (the `NaN` fix) by **keeping the file**, verbatim, while the
other parent's deletions of everything it imports went through unopposed:

| what the script names | state on the base branch | errors |
|---|---|---|
| `@pagespace/db/schema/agent-workspace-layout` | file deleted, export-map entry removed | 1 × `TS2307` |
| `conversations.workspaceId` | dropped from the Drizzle schema | 4 × `TS2339` |
| `conversations.closedInWorkspaceAt` | dropped from the Drizzle schema | 2 × `TS2339` |

`tsc` over the base script, **against a fully built tree**, reports **7 real
errors** plus the expected `import.meta.main` one — 8 in total — and nothing in
the repository could see any of them: `scripts/` is inside no tsconfig, and no
test imported the backfill. (`agentWorkspaceNodes` still resolves from
`@pagespace/db/schema`; I narrowed that import to
`@pagespace/db/schema/agent-workspace-nodes` as tidy-up, not as a repair.) This
is finding 1's shape exactly — the `NaN` census — one turn further round the
same wheel, and it arrived through a merge rather than through an edit.

Migration `0256` is on this branch and its own header names this script as the
pre-flight that must run first, so the script has to work. I repaired it rather
than re-deleting it: **a migration's subject is the schema it is migrating FROM,
which by definition stops existing the moment it succeeds**, so pointing it at
the live app schema was the original mistake. `scripts/lib/legacy-workspace-layout.ts`
now declares the pre-`0256` shapes the backfill reads — the two layout tables and
the two `conversations` membership columns — read-only, only the columns the
derivation consumes, with a header saying to delete it when the script goes.

`0256`'s own comment still claims the script was "now deleted with the tables it
read". I left that SQL untouched (`CLAUDE.md`: never edit `packages/db/drizzle/`)
and record the discrepancy here instead.

---

## 1. Finding 2 (HIGH) — the pane load now applies the membership predicate

`packages/lib/src/agent-workspaces/workspace-node-backfill.ts` ·
`scripts/backfill-agent-workspace-nodes.ts`

**The rule.** A chat pane whose target is absent from the new
`DeriveOptions.openConversationIds` is **not materialised at all** — not as a
bound pane, and not as an unbound rectangle either, because an empty picker
sitting where a dismissed thread used to be is still a slot the user did not ask
for. The set is `loadOpenConversationIds`, the same predicate `loadSources`
already applied to the membership load (`isActive`, `closedInWorkspaceAt IS
NULL`), resolved over every conversation any pane row of the batch names — not
scoped to a workspace, because a pane may name a thread in another session and
the question is "is this a member anywhere".

Three cases, two note codes, both meaning *dropped*:

| the thread | how | note |
|---|---|---|
| dismissed out of the listing | `closedInWorkspaceAt` stamped, row alive | `chat_pane_not_a_member` |
| history-deleted | `isActive = false`, row alive | `chat_pane_not_a_member` |
| hard-deleted with its page/drive | no row at all | `chat_pane_no_conversation` |

The third changes a documented behaviour, so it is argued rather than assumed:
*"a node pointing at a deleted conversation repairs at read time"* was written
for a node whose thread is deleted **later**, where `expelConversationFromSession`
runs at deletion time and removes it. Nothing will ever run for a thread deleted
before the cutover, so that node would be a permanent member holding a cap slot
that nothing can release. It is dropped. A caller that supplies no
`openConversationIds` still carries such a pane, unchanged — absence of the
option means "nobody asked", not "everything is open", and the existing test for
that path is untouched.

Ordering matters and is asserted: the drop is answered **before** the claim
rules, so a dismissed thread reports `chat_pane_not_a_member` and not
`chat_target_foreign` — an operator sent looking for a cross-workspace
contention that does not exist is worse off than one told nothing.

Terminals and pages are untouched. They carry no membership, and opening one
page in two panes is a legitimate thing a user does.

### The position decision: RENUMBER, and no hole is representable

`position` must stay contiguous per sibling group or `validateTree` refuses the
whole workspace, so a hole is not an option the model has. The partition runs
**before** anything else reads `source.panes` — before ids are reserved, before
columns are ordered, before bindings resolve — so everything downstream sees a
workspace in which the row simply does not exist, and every consequence falls
out of a rule the derivation already had:

* **siblings renumber** — `position` is assigned from the sort's index and never
  copied from `orderIndex`, the rule that already existed for renumbering a
  column with a gap in it;
* **a column the removal empties is dropped** — by the same rule that drops a
  column that was empty to begin with, and it still emits `empty_column_dropped`,
  which I initially expected it not to and the rehearsal disproved (the column
  row is still in `source.columns`; only its panes left). The test now asserts
  both notes;
* **a column reduced to one pane collapses** — the survivor takes the column's
  place and share, by the same rule that handles a one-pane column, and keeping
  the split would be a `degenerate_split` that skips the whole workspace;
* **a shrunken group's shares read as unsized** — the remainder no longer sums
  to 1, so `settleGroupShares` discards it wholesale and notes
  `fractions_read_as_unsized`, exactly as it already did for a half-sized column;
* **a dropped pane's id reserves nothing**, so it cannot rename a column that
  happens to share it.

`validateTree` passes on every fixture; `assertWritable` (which runs
`validateTree` **and** `buildRenderTree(...).orphaned === []` on every written
derivation in the suite) covers all fourteen new cases.

### Verified on a real pre-`0256` database

A throwaway `pagespace_fb` on the shared test container, migrated through
`0255` and **not** `0256` (256 migration files applied in journal order; the
container's other databases were left untouched, and `pagespace_fb` was dropped
afterwards). Seeded with production shape #1 plus one of each dangerous row.

Same workspace's real rows, through the same function, with and without the
predicate:

```
BEFORE (pane load unfiltered): paneNodes=5 chat-bound=[t-open, t-dismissed, t-histdel, t-hard-gone, t-unseen]
AFTER  (same predicate)      : paneNodes=2 chat-bound=[t-open, t-unseen]
```

And the rows the live `--apply` actually wrote for it:

```
       id       | nodeType |  parentId  | position | targetKind | targetId
----------------+----------+------------+----------+------------+----------
 ws-a::root     | root     |            |        0 |            |
 pa1            | pane     | ws-a::root |        0 | chat       | t-open
 t-unseen::pane | pane     | ws-a::root |        1 | chat       | t-unseen
```

Contiguous, no hole, and the dismissed, history-deleted and hard-deleted threads
have no node.

---

## 2. Finding 3 (MEDIUM-HIGH) — a skipped workspace

### (a) The false fallback — corrected, and turned into a gate

The derivation's docblock promised a non-derivable workspace was *"REPORTED and
left on the old tables, which still work."* That was true only inside the
migration window. `0256` drops the layout tables and the membership columns, so
after cutover a skipped workspace has no grid and no membership anywhere. The
docblock now says that, and so does the script's procedure — which gained a step
5 (`0256`) and a statement that step 2's exit code is the gate on it.

**There is now a zero-skip gate.** `runIsClean(totals)` is one definition read by
both the report banner and `process.exit`, so what a human sees and what an
automation checks cannot disagree:

```ts
return totals.membersIn === totals.paneNodesOut && totals.skipped === 0 && totals.failed === 0;
```

Measured: a run with one skipped workspace **exits 1**; after the skip was
repaired, the same run **exits 0**. Previously it exited 0 in both cases — see
§4, because the reason it did is finding 5.

### (b) The re-claim hole — still live, and the gate is the fix

`claim-conversation-in-workspace.ts:117-126` still passes when
`findWorkspaceOfConversation` returns `null`, and a skipped workspace has no
nodes, so its threads read as homeless and can be claimed into a *different*
workspace. I did not change that check, and deliberately: `home === null` is the
correct answer for a thread that genuinely has no workspace, and the comment
beside it is right that the unique index is the enforcement — but the index only
refuses what an existing node claims, and a skipped workspace has none. There is
no local repair; the fix is for the skip not to happen, which is what the exit
code now enforces. The census names every such workspace individually.

### (c) Reachability — **already unreachable on this branch**

The audit's finding 3(c) said an authenticated caller could opt a workspace out
of the migration permanently by POSTing whitespace ids to the legacy verb route.
That route is **gone**: `7764517cf` deleted
`apps/web/src/app/api/agent-workspaces/[workspaceId]/workspace/verbs/route.ts`
(127 lines) and `.../workspace/route.ts` (78 lines) along with
`workspace-layout-verbs.ts` and `workspace-layout-store.ts`. Nothing in the
application writes `agent_workspace_panes` any more, so no client can mint a row
the derivation will refuse. **Yes — it is unreachable, and not by anything I
did.** What remains is historical data: a blank-id row already in the table from
before the route was deleted. That is what the exit-code gate exists for, and it
is the shape the `ws-skip` rehearsal fixture reproduces.

---

## 3. Finding 5 (MEDIUM) — the totals count only what was written

`recordCensus` ran **before** the skip check, so a workspace that wrote nothing
still added its members, its panes and its nodes to the headline — and because
the defect assertion compares two of those same conflated numbers, a skip
inflated both sides equally and hid itself from the only automated check the run
made. A failed write did the same.

The run loop now records nothing into the headline until the rows exist:

```
derive → skipped?      → recordNotWritten(reason: 'skipped')    → continue
       → write throws? → recordNotWritten(reason: 'write_failed') → continue
       → recordWritten
```

`recordNotWritten` keeps the workspace's own counts in a `notWritten[]` entry
rather than discarding them — `panesIn: 2` on a skip is the size of the hole
`0256` is about to make, and it belongs in the section that is about that
workspace, not in a total that claims to describe the migration.

Pinned by test: over a mixed run, `panesIn`/`membersIn`/`paneNodesOut`/
`nodesOut`/`seatedOut` are byte-identical to the same run with the skipped
workspace removed entirely.

---

## 4. Before / after — what the census shows an operator

Both from the same rehearsal database, same three workspaces, same rows.

### Before

The script **could not be imported**, so the honest "before" is what the base
branch's code would have printed had it resolved. Reconstructed from its own
source, and from the measurements above:

```
ws-a: panes 4→4, threads 2, shells 0, members 4→4, seated 1, nodes 6
ws-b: panes 2→2, threads 1, shells 1, members 2→2, seated 0, nodes 4
⚠️  ws-skip SKIPPED (blank_id): a node carries a blank id; …

── census (dry run) ─────────────────────────────
  live workspaces scanned : 3
  skipped (not derivable) : 1
  pane rows in            : 8      ← ws-skip's 2 counted in, though it wrote nothing
  members in              : 8      ← ws-skip's 2 counted in
  pane nodes out          : 8      ← and again, so the DEFECT check cancels out
  …
  skips     : {"blank_id":1}
                                   ← no defect line. exit 0.
```

Four things it could not show:

1. **that three of ws-a's four panes were about to reopen threads the user had
   closed** — `panes 4→4` is the only line about them, and it is the same line a
   healthy workspace prints;
2. **which workspace was skipped** — `skipped: 1` names nothing, and the ids are
   only in scrollback above the totals;
3. **what a skip costs** — nothing says `0256` will empty it;
4. **that ws-skip's numbers were inside the totals** — and, because they were
   inside both `membersIn` and `paneNodesOut`, that the `❌ DEFECT` check was
   comparing a number to itself. **The run exited 0.**

### After

Actual output, `bun scripts/backfill-agent-workspace-nodes.ts`:

```
   ws-a: panes 4→1 (3 not a member), threads 2, shells 0, members 2→2, seated 1, nodes 3 ·
         chat_pane_not_a_member,chat_pane_not_a_member,chat_pane_no_conversation,
         empty_column_dropped,fractions_read_as_unsized
   ws-b: panes 2→2, threads 1, shells 1, members 2→2, seated 0, nodes 4
   ⚠️  ws-skip SKIPPED (blank_id): a node carries a blank id; an id addresses a node, …

── census (DRY RUN — nothing was written) ─────────────────────
  live workspaces scanned : 3
  already migrated (skip) : 0
  would write             : 2
  skipped (NOT derivable) : 1
  write failures          : 0

  ── what WOULD be written ──
  pane rows read          : 6
    NOT materialised      : 3
      dismissed / deleted : 2
      no conversation row : 1
  ↳ panes bound to threads that are NOT members. Materialising one would put a
    thread the user closed back on their grid; these are deliberately dropped.
  pane rows materialised  : 3
  open conversations in   : 3
  shells in               : 1
  members in              : 4
  pane nodes out          : 4
    of which seated       : 1
  total nodes out         : 7
  membership dropped      : 0

  anomalies               : {"chat_pane_not_a_member":2,"chat_pane_no_conversation":1,
                             "empty_column_dropped":1,"fractions_read_as_unsized":1}

  ── NOT WRITTEN — read every line of this ──
  ❌ 1 workspace(s) produced no rows. Migration 0256 DROPS the layout
     tables and the membership columns, so each of these loses its grid outright and
     its threads become claimable into a different workspace. DO NOT APPLY 0256.

     ws-skip  SKIPPED(blank_id)  held 2 pane(s), 2 thread(s), 0 shell(s)
        a node carries a blank id; an id addresses a node, and this one addresses nothing

  skips                   : {"blank_id":1}

❌ NOT SAFE TO CUT OVER — resolve everything above before applying migration 0256
```

**exit 1.** With the blank id repaired and re-run with `--apply`: `skipped: 0`,
`already migrated (skip): 1` (ws-a from the earlier partial run — the resume
path), `✅ clean — every scanned workspace is accounted for, and 0256 may be
applied`, **exit 0**.

`panesIn` deliberately still counts every ROW READ rather than only the
survivors. `panes 4→1` is the difference between what production holds and what
the cutover keeps; a census that printed only the second number would show a
clean migration of a workspace that just lost three quarters of its grid.

---

## 5. Mutation table

Every mutation applied to the shipped source, suite re-run, file restored, tree
verified clean. Named failures are from the new group.

### The derivation — `bun run --filter @pagespace/lib test -- src/agent-workspaces/__tests__/workspace-node-backfill.test.ts` (71 tests)

| # | mutation | result | first named kill |
|---|---|---|---|
| M1 | the predicate removed entirely — always keep | **13 failed** | `does not materialise a pane whose conversation was DISMISSED …` |
| M2 | drop only when the row is MISSING (dismissed thread survives) | **12 failed** | `… was DISMISSED out of the workspace` |
| M3 | drop only when the row EXISTS (deleted thread survives) | **4 failed** | `… has NO ROW at all` |
| M4 | keep the pane but UNBIND it — the tempting wrong fix | **10 failed** | `RENUMBERS the survivors rather than leaving a hole` |
| M5 | `membersIn` counts pane ROWS instead of materialised panes | **14 failed** | `counts the drop in the census and keeps membersIn === paneNodesOut` |
| M6 | one note code for both reasons | **2 failed** | `materialises no node for the dismissed thread, and none for the deleted one` |

M4 is the one worth reading. Unbinding rather than dropping keeps
`membersIn === paneNodesOut` intact and passes `validateTree`, so it would have
looked correct — it is killed by the position, collapse and census tests, not by
the identity.

The pre-existing rule the audit's finding 8 found unpinned
(`settleGroupShares`' `shares.length < 2`) is **still unpinned**; it is not in
this brief's scope and I did not weaken anything that touches it.

### The operator's readout — `cd scripts && bunx vitest run __tests__/backfill-census.test.ts` (19 tests)

| # | mutation | result | kills |
|---|---|---|---|
| M7 | `runIsClean` drops the `skipped === 0` term | **1 failed** | `FAILS THE RUN — the gate the procedure only asked a human to apply` |
| M8 | `recordNotWritten` folds the census into the headline totals | **3 failed** | all three "counts ONLY what was written" cases |
| M9 | `runIsClean` drops the `failed === 0` term | **1 failed** | `fails the run for a WRITE FAILURE too, and names that workspace as well` |
| M10 | the `NOT WRITTEN` section suppressed | **3 failed** | `names the workspace, its code and what it held`; `says what happens to it at 0256`; the write-failure case |

M7 and M9 kill one test each, and that is the intended shape: the skip term and
the failure term are separately guarded, so weakening either one is caught by
the case that is about it rather than by a blanket assertion that would survive
half a regression.

---

## 6. Gates

| gate | result |
|---|---|
| `bun run build` | **exit 0** — 14/14 |
| `bun run typecheck` (MONOREPO, after build) | **exit 0** — 17/17, 0 `error TS` |
| `bun run lint` (MONOREPO) | **exit 0** — 15/15 |
| `bun run --filter @pagespace/lib lint` | **exit 0** |
| `bun run --filter @pagespace/lib test -- src/agent-workspaces` | **610 passed / 610**, 19 files |
| `cd scripts && bunx vitest run` | 291 passed, 14 skipped, **1 failed** — pre-existing, see below |
| `bun run lint:scripts` | **exit 0** |
| `bun run knip:check` | green — 4 issues, all within baseline (4) |
| `tsc` over `backfill-agent-workspace-nodes.ts` | **1 error**, the expected `import.meta.main` — was **8** (7 real) |
| `tsc` over `scripts/lib/backfill-census.ts` + `legacy-workspace-layout.ts` | **exit 0**, no errors |
| the script, run against a real pre-`0256` database | dry **exit 1** with a skip, `--apply` **exit 0** clean |

**The one red scripts suite is pre-existing and untouched by this branch.**
`__tests__/tenant-export-columns.test.ts` fails on
*"`agent_workspace_node_revs`, `agent_workspace_nodes` reference a table the
tenant export carries, but nothing says whether they travel"* — the open
carry-or-exclude decision `.pu-reports/pu-delete-old-model.md` §6 already
recorded as its single failure. It names no file this branch changed.

`bun run typecheck` failed once, in `@pagespace/cli/src/commands/trash.ts`, on a
run started while `bun run build` was still in flight (`web:build: exited with
code 130`). Re-run against a completed build: 17/17, and `trash.ts` was last
touched by `c3d49c38a`, months before this epic.

`bun run knip:check` reports 4 issues on a tree that has been built — the
gitignored Capacitor `cordova*.js` assets `bun run build` generates. Moved
aside and re-run: `[ok] knip: 4 issue(s), all within baseline (4)`, exit 0; then
restored. CI's knip step runs in the `lint` job, which never builds.

---

## 7. Files

| file | change |
|---|---|
| `packages/lib/src/agent-workspaces/workspace-node-backfill.ts` | `openConversationIds`; `partitionPanesByMembership`; two note codes; `panesDroppedNotMember`; `membersIn` counts materialised panes; the "old tables still work" docblock corrected to say what `0256` does |
| `packages/lib/src/agent-workspaces/__tests__/workspace-node-backfill.test.ts` | 14 new cases; a production fixture carrying a dismissed pane and a deleted one; census fixtures now supply the predicate |
| `scripts/lib/legacy-workspace-layout.ts` | **new** — the pre-`0256` tables and columns the backfill reads |
| `scripts/lib/backfill-census.ts` | **new** — totals, per-workspace line, report and `runIsClean`, pure and importable without a database |
| `scripts/__tests__/backfill-census.test.ts` | **new** — 19 cases. The first test anywhere that reads this script's output |
| `scripts/backfill-agent-workspace-nodes.ts` | imports repaired; `loadOpenConversationIds`; run loop records only what was written; report and exit gate delegated; procedure rewritten with `0256` as step 5 |

## 8. Left undone, deliberately

* **`0256`'s header still says the backfill script is deleted.** Correcting it
  means editing an applied-elsewhere migration file; `CLAUDE.md` forbids editing
  `packages/db/drizzle/`. Recorded here.
* **Finding 3(b)**, the `home === null` re-claim path — argued in §2(b). No local
  repair exists; the exit-code gate is the fix.
* **The audit's finding 8**, the unpinned lone-member share rule. Same module,
  outside this brief.
* **Whether the script should exist at all.** `7764517cf` deleted it and a merge
  brought it back. I repaired it because `0256` names it as the pre-flight that
  must run first, so deleting it makes `0256` unsafe to apply. If the decision is
  that both go, they go together — the script, `scripts/lib/legacy-workspace-layout.ts`,
  `scripts/lib/backfill-census.ts`, both test files, and
  `workspace-node-backfill.ts` — and `0256`'s pre-flight instructions need
  another home.
