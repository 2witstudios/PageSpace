# `agent_workspace_nodes` in the tenant export

**Branch** `pu/tenant-export`, on `pu/workspace-node-model` (`d465933f3`). Closes
`closing-verdict.md` finding 2 and `sanity-2026-08-09-10.md` finding 1. No PR opened, nothing
merged, no board task touched.

**What was red.** `ci.yml:135` (`cd scripts && bunx vitest run`) failed the table drift guard:
`agent_workspace_node_revs, agent_workspace_nodes reference a table the tenant export carries, but
nothing says whether they travel`. It is green now. Every number below was produced by running
something; every mechanism claimed is mutation-checked in §5.

---

## 1. The decision, and where it is written down

**`agent_workspace_nodes` is CARRIED** — `TABLE_IMPORT_ORDER`, a spec in `TENANT_EXPORT_COLUMNS`
(all eleven columns, no exclusions), a query in `tenant-export.ts`, an id comparison in
`tenant-validate.ts`.

The reasoning is recorded at the decision site rather than here, because the module's own history is
that `agent_workspace_shells` drifted precisely when nobody wrote anything down. Three places:

* `TENANT_EXPORT_COLUMNS['agent_workspace_nodes']`'s docblock — what the table is and what happens
  to a polymorphic target that leaves the bundle.
* The header above `TENANT_EXPORT_EXCLUDED_TABLES` — **the test this region applies**, stated once
  so the next such decision does not have to be re-derived: a table in the FK closure is excluded
  only when its rows describe the SOURCE INSTANCE (a Sprite in a fleet the tenant cannot reach, a
  stream another deployment's worker is midway through, a counter another database issued).
  Everything a user would notice the absence of on the morning after their migration travels.
* The former "UNDECIDED" note, replaced by the decision: membership used to be
  `conversations.workspaceId`, an ordinary carried column, and the pane grid beside it was excluded
  because *arrangement* was judged not worth the bundle weight. This epic merged the two structures
  into one table, which merged the two decisions into one — the only way to keep dropping the
  arrangement was to start dropping the membership with it. Membership travelled before and travels
  now; arrangement rides along, and is no longer separable from the thing that had to travel anyway.

**`agent_workspace_node_revs` is EXCLUDED**, with the reason keyed in `TENANT_EXPORT_EXCLUDED_TABLES`
and argued in the docblock above it. It is a per-workspace monotonic mutation counter, minted by
`INSERT … ON CONFLICT ("rootId") DO UPDATE SET rev = rev + 1` inside the transaction that writes the
nodes, and it is meaningful only against the database that issued it: a client holds it as `baseRev`
and every write is refused unless the server's rev still matches. Carrying a foreign one would have a
tenant's first write compare a client's base against a number another database counted.

Its absence is not merely tolerable — it is a state the read path was built to handle.
`readWorkspaceNodeSnapshots` (`packages/lib/src/services/agent-workspaces/workspace-node-store.ts:197`)
FULL OUTER JOINs the two tables and `COALESCE(r."rev", 0)`s **specifically** so a workspace with node
rows and no rev row reads as `{rev: 0, nodes: […]}` rather than as empty; its docblock says so, and
names the backfill as the producer of that shape. An import is simply its second producer. The
tenant's first write then mints rev 1, which is where a fresh workspace starts. Verified end to end:
after an import, `agent_workspace_node_revs` holds **0 rows** while the workspace holds **2 nodes**.

## 2. Per-`targetKind`: what happens to a target outside the bundle

`targetId` is polymorphic with no FK, so `nullifyOrphanedRefs` cannot reach it — there is nothing to
follow. `unbindOutOfBundleTargets` (`scripts/tenant-export.ts`) checks each row against the set its
`targetKind` names and, when the target does not travel, **nulls `targetKind` and `targetId`
together**. The node itself always travels.

| `targetKind` | checked against | out-of-bundle case that actually arises | decision |
|---|---|---|---|
| `chat` | the exported `conversations` | a session owned by a user DISCOVERED through a page-chat arm holds threads the requested-user predicate does not carry | **unbind** |
| `terminal` | the exported `agent_workspace_shells` | a shell whose `ownerId` is outside the migration; both its FKs are NOT NULL, so there is no orphan-and-carry shape and it simply does not travel | **unbind** |
| `page` | the exported `pages` | a document or plan open in a pane that lives in a drive this migration does not carry | **unbind** |
| — | — | a row that is ALREADY half-bound (kind set, id NULL — no CHECK forbids it) | **cleared**, not carried forward |

**Unbind, not prune, and the choice is not stylistic.** A pane's parent split exists to divide space
between at least two children; `validateTree` calls anything less `degenerate_split`
(`workspace-node-validate.ts:383`), and `nodesFromRows` rejects the whole set rather than the bad
row. So deleting one pane on the way out turns *"one thread did not come with you"* into **"this
workspace does not open"**. Repairing that properly means collapsing the split and reseating
fractions — re-implementing the node algebra inside a SQL exporter. Nulling the pair preserves the
tree exactly and lands on a state the model spells natively: an unbound pane rendering the target
picker, which is what a user sees when they split a pane and have not yet chosen its contents.

**Both columns or neither**, for the same reason: the row parse refuses a half-bound pane outright
(*"a pane target needs both a kind and an id, or neither"*, `workspace-node-rows.ts:194`) and refuses
the workspace with it. Clearing one column would export precisely the unreadable state the paragraph
above avoids. This is the `agentPageId` / `planPageId` precedent — null a binding that leaves the
bundle — applied to a pair rather than a column.

**The composite self-FK cannot be split by this exporter.** `(rootId, parentId) → (rootId, id)` puts
`rootId` on both sides, so a node's parent is always in its own workspace; the query is
`WHERE "rootId" IN (…exported sessions…)`, which takes every row of a carried session, and nothing
downstream removes rows (the unbinding rewrites two columns and drops none). A tree therefore travels
whole or not at all — there is no predicate that could separate a child from its parent. Row ORDER
inside the INSERT is likewise irrelevant: Postgres queues RI checks as AFTER-ROW triggers fired at
statement end. Measured, on a table shaped like this one: a three-row INSERT listing `leaf` before
`split` before `root` → `INSERT 0 3`.

## 3. The importer on a chat-index collision: **it fails the bundle, loudly**

`UNIQUE (targetId) WHERE targetKind = 'chat'` is global, so a destination that already holds one of
the incoming threads cannot also take the incoming node. Every INSERT the bundle emits ended
`ON CONFLICT DO NOTHING`, and **untargeted, that forgives the collision like any other**: the node
would be skipped in silence, the import would report success, and one thread would be missing from
the workspace it belongs to — found months later by the user who lost it.

`buildInsert` now takes an optional conflict target and the nodes INSERT passes its primary key:

```sql
INSERT INTO "agent_workspace_nodes" (…) VALUES … ON CONFLICT ("rootId", "id") DO NOTHING;
```

Only "this bundle was already imported" is forgiven. Anything else raises and aborts the single
`BEGIN`/`COMMIT` the whole bundle replays in — nothing lands, and the operator resolves a real
conflict between two databases instead of discovering it as an absence.

Measured on a throwaway database (created, probed, dropped) on the shared test container:

| statement | result |
|---|---|
| `ON CONFLICT DO NOTHING`, foreign chat collision | `INSERT 0 0` — **silently skipped**, table unchanged |
| `ON CONFLICT ("rootId", id) DO NOTHING`, same row | `ERROR: duplicate key value violates unique constraint "n_chat_idx"` |
| `ON CONFLICT ("rootId", id) DO NOTHING`, re-inserting an IDENTICAL row | `INSERT 0 0`, no error |

The third row is why idempotency survives the narrowing: Postgres consults the arbiter index first
and never speculatively inserts, so a row cannot collide with its own chat binding. Pinned by the
pre-existing *"is idempotent — re-import skips existing rows"* test, which now also asserts the node
count is 2 rather than an error.

Through the real importer: a destination holding the same conversation under a different session
makes `runImport` reject with `agent_workspace_nodes_chat_target_idx` in the message, the
destination's own binding survives intact, and the incoming `agent_workspaces` row does **not** land
beside it.

## 4. Gate numbers

| gate | result |
|---|---|
| `cd scripts && bunx vitest run` (**ci.yml:135**) | **exit 0** — Test Files 15 passed \| 1 skipped (16); Tests **307 passed \| 14 skipped (321)** |
| …the same command before this work | 1 failed \| 291 passed \| 14 skipped (306) — the table guard |
| `scripts/__tests__/tenant-export-columns.test.ts` | **73 passed (73)**; was **1 failed \| 69 passed (70)** |
| `bun run typecheck` (monorepo) | **17/17 successful, exit 0** |
| `tsc --noEmit` over the 11 tenant-migration files ¹ | **exit 0, zero errors** |
| `bun run --filter @pagespace/lib lint` | **exit 0** |
| `bun run lint` (monorepo) | **15/15 successful** |
| `eslint` over the changed `scripts/` files (`scripts/eslint.config.mjs`) | **exit 0** |
| `bun run knip:check` | **ok — 4 issues, all within baseline (4)** |

¹ `scripts/` is in no turbo typecheck project (`sanity-verdict-2` finding 1), so the monorepo run
above does not cover these files. Checked separately against the root `tsconfig.json`'s options with
`--listFiles` confirming all 11 files and `packages/db/src/schema/agent-workspace-nodes.ts` were
actually compiled, so the exit 0 is not vacuous.

Test counts by file: `tenant-export.test.ts` 24 → **32**, `tenant-import.test.ts` 18 → **22**,
`tenant-export-columns.test.ts` 70 → **73** (three `it.each` blocks over `TABLE_IMPORT_ORDER`),
`tenant-validate.test.ts` unchanged at 9 — its existing *"validates every table in
`TABLE_IMPORT_ORDER`"* assertion (`toHaveLength(TABLE_IMPORT_ORDER.length)`) is what forced the new
validator query into existence.

## 5. Mutation checks — every mechanism broken, and what went red

No coverage is claimed that was not watched failing.

| # | mutation to the shipped source | result |
|---|---|---|
| 1 | drop the `['rootId','id']` conflict target → blanket `ON CONFLICT DO NOTHING` | **2 import tests red**, and the second one shows the exact silent failure: the import SUCCEEDED, the incoming workspace landed, the node vanished. Plus `forgives only a primary-key conflict` red |
| 2 | `unbindOutOfBundleTargets` returns immediately | **4 export tests red** (chat, terminal, page, half-bound) |
| 3 | null `targetId` only, leaving `targetKind` set | **4 export tests red** — the "both columns or neither" rule ² |
| 4 | scope the node query `AND "targetId" IS NOT NULL` instead of by `rootId` alone | **`carries a whole tree` red** — *expected 3 to be 5*; the split and the root are exactly what such a filter loses |
| 5 | delete the `agent_workspace_nodes` INSERT from the bundle | **`restores the thread's membership in its session` red** — *expected [] to have a length of 2*: the regression itself |
| 6 | rename the `agent_workspace_node_revs` exclusion key | **registry guard red** with the "nothing says whether they travel" message |

² Mutation 3 initially turned only 2 of the 4 red — the terminal and page tests asserted the id was
gone but not the kind. Both were strengthened, and the re-run is the 4 recorded above.

## 6. Files touched

```
scripts/lib/migration-types.ts           +13  −2  TABLE_IMPORT_ORDER, ManifestTableCounts, and the
                                                  stale "conversations.workspaceId FKs here"
                                                  ordering comment for a column that is now dropped
scripts/lib/tenant-export-columns.ts     +76 −21  the spec, the recorded exclusion, the reasoning
scripts/lib/migration-utils.ts           +26  −1  buildInsert's optional conflict target
scripts/tenant-export.ts                +127  −5  the query, unbindOutOfBundleTargets, the INSERT
scripts/tenant-validate.ts               +11      the compound-key id comparison (rootId:id — node
                                                  ids are client-minted and unique per workspace only)
scripts/__tests__/tenant-export.test.ts +227      8 tests
scripts/__tests__/tenant-import.test.ts +142  −2  4 tests + the idempotency assertion
```

`CHANGELOG.md` is untouched: it documents user-facing product changes, and the tenant export/import
scripts are an operator tool run during a cloud → dedicated migration. The registry work this
follows — the eighteen silently-dropped columns, the `agent_workspace_shells` table — added no
entries either.

## 7. Not done, deliberately

* **`packages/db/src/schema/agent-workspace-nodes.ts:233`** — the `oneNodePerChat` docblock still
  justifies the constraint by citing `conversations.workspaceId` (*"set at creation and permanent"*),
  a column `0256` drops. The constraint and the rule it protects are unchanged and correct; only the
  citation is stale. Schema prose, outside an export brief — recorded so it is not re-derived.
* Nothing in `packages/lib/src/compliance/export/` needed changing: the GDPR export already carries
  `agent_workspace_nodes` (`gdpr-export.ts:991`) and its coverage map already keys it. The two
  exports now agree about this table, and their one recorded disagreement stays
  `ai_stream_sessions` — out loud, as its pin requires.
