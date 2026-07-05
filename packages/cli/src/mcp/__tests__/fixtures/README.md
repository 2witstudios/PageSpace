# v5.2.7-tools.json — derivation

The parity contract for Phase 6 task 2 (`docs/sdk/operations-inventory.md`,
task page `l07x7hy9c30vr0io3ov3se2t`) was originally pinned to the OLD
`pagespace-mcp` MCP server **at its `v5.2.2` git tag** — see "Historical:
v5.2.2 derivation" below. It has since been re-pegged to **v5.2.7**, the
tool's final, deprecated release (`package.json` version `5.2.7`,
`chore: final deprecated release (5.2.7) — point at @pagespace/cli`) — the
actual deprecation target, not an intermediate snapshot.

`pagespace-mcp` (`/path/to/pagespace-mcp`) has no git tag for
5.2.7 — its only tags are `v4.0.1` and `v5.2.2` — so the pin is the immutable
commit SHA at the tip of `pu/final-deprecated-version`:
`494204446bd1b87cdcfe0323795ee220e3566ecf`.

## How `v5.2.7-tools.json` was generated

1. `cd /path/to/pagespace-mcp && git show 494204446bd1b87cdcfe0323795ee220e3566ecf:src/tools.js > /tmp/v527-tools.mjs`
   — extracts `src/tools.js` as it existed at that commit, without touching
   the working tree.
2. `bun run extract-v5.2.7-tools.mjs /tmp/v527-tools.mjs > v5.2.7-tools.json`
   (the script in this directory) — mechanically imports that file as an ES
   module and maps every entry in its exported `tools` array to
   `{ name, required }`, where `required` is `inputSchema.required ?? []`.
   No hand-transcription; the fixture is exactly what `tools.js` declared.

Result: **70 tools** — the v5.2.2 gate's 67, plus the 3 added since (see
below).

## v5.2.2 -> v5.2.7 delta

`git diff v5.2.2 494204446bd1b87cdcfe0323795ee220e3566ecf -- src/tools.js` (in
the `pagespace-mcp` repo) shows exactly 3 tools added, none removed, no tool
renamed, and exactly 2 of the 67 pre-existing tools gaining new
*top-level-required* fields (many other tools gained new *optional* fields
or nested-object required fields — e.g. `agentTrigger.agentPageId` inside
`create_task`/`update_task` — neither of which affects this fixture, which
only records each tool's own top-level `required` array):

| Change | Status against the current SDK registry |
|---|---|
| `set_home_page` added | Now covered — `drives.setHomePage` (added alongside this re-peg) |
| `insert_lines` added | Already covered — `pages.insertLines` |
| `delete_lines` added | Already covered — `pages.deleteLines` |
| `set_role_page_permissions` gained required `canView`/`canEdit`/`canShare` | Already covered — `roles.setPagePermissions`'s `permissionsPatch` always carried the full `PagePerm` triple (fix #1765 predates this); `fixtures/v5.2.7-parity-map.ts` now documents the reshape for these 3 fields explicitly instead of leaving them an unmapped-field gap |
| `set_role_drive_wide_permissions` gained required `canView`/`canEdit`/`canShare` | Already covered — `roles.setDriveWidePermissions`'s `driveWidePermissions` object always carried the full triple; same explicit reshape documentation added |

The count-assertion test (`../v5.2.7-parity.test.ts`, "fixture has exactly 70
tools") is a literal, **not** cross-checked against
`docs/sdk/operations-inventory.md` — that document is frozen Phase 0 ground
truth for the original v5.2.2 gate (its own header says
"Status: ADR / frozen ground truth") and is deliberately never updated for
this re-peg.

## Why not just read the current `pagespace-mcp` repo at test time

- **Auditability**: a pinned commit is immutable; importing the live repo at
  test time would make the parity gate's pass/fail depend on whatever that
  external repo happens to contain when the test runs — silently drifting
  ground truth is exactly the failure mode this gate exists to prevent. See
  `s5kfa3mc4boyjqrsfzvwocx4` (Phase 6 law): "commit the extracted list as a
  fixture."
- **No runtime dependency** on a second, unversioned local checkout existing
  at a specific path on whatever machine runs the test suite.

## Regenerating

```bash
cd /path/to/pagespace-mcp
git show 494204446bd1b87cdcfe0323795ee220e3566ecf:src/tools.js > /tmp/v527-tools.mjs
cd -
bun run packages/cli/src/mcp/__tests__/fixtures/extract-v5.2.7-tools.mjs /tmp/v527-tools.mjs \
  > packages/cli/src/mcp/__tests__/fixtures/v5.2.7-tools.json
```

Only re-run this if `pagespace-mcp` ever amends that commit (it shouldn't —
it's the tool's final, deprecated release) or a future phase deliberately
re-pins the parity contract to a newer target.

---

## Historical: v5.2.2 derivation

The original gate (superseded by the above) was generated the same way,
pinned to the `v5.2.2` git tag instead of a commit SHA:

1. `cd /path/to/pagespace-mcp && git show v5.2.2:src/tools.js > /tmp/v522-tools.mjs`
   — extracts `src/tools.js` as it existed at the `v5.2.2` tag (commit
   `93ee576`, "chore: bump to 5.2.2").
2. The same extraction script (then named `extract-v5.2.2-tools.mjs`)
   produced `v5.2.2-tools.json`: **67 tools**, matching
   `docs/sdk/operations-inventory.md`'s "Tool count: 67 registered tools"
   line.

Both `v5.2.2-tools.json` and `extract-v5.2.2-tools.mjs` were removed when
the gate was re-pegged — this section exists purely as a paper trail for
where the 67-tool baseline came from.
