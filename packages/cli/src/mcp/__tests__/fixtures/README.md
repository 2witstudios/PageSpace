# v5.2.2-tools.json — derivation

The parity contract for Phase 6 task 2 (`docs/sdk/operations-inventory.md`,
task page `l07x7hy9c30vr0io3ov3se2t`) is the OLD `pagespace-mcp` MCP server
**at its `v5.2.2` git tag** — not its current HEAD. The tool's own repo
(`/Users/jono/production/pagespace-mcp`) has kept moving since (it's at
5.2.6 as of this writing: `chore: bump to 5.2.6`), adding tools the v5.2.2
contract never had. Pinning to the tag, not HEAD, is what makes this fixture
a stable, auditable ground truth instead of a moving target.

## How `v5.2.2-tools.json` was generated

1. `cd /Users/jono/production/pagespace-mcp && git show v5.2.2:src/tools.js > /tmp/v522-tools.mjs`
   — extracts `src/tools.js` as it existed at the `v5.2.2` tag (commit
   `93ee576`, "chore: bump to 5.2.2"), without touching the working tree.
2. `bun run extract-v5.2.2-tools.mjs /tmp/v522-tools.mjs > v5.2.2-tools.json`
   (the script in this directory) — mechanically imports that file as an ES
   module and maps every entry in its exported `tools` array to
   `{ name, required }`, where `required` is `inputSchema.required ?? []`.
   No hand-transcription; the fixture is exactly what `tools.js` declared.

Result: **67 tools**, matching `docs/sdk/operations-inventory.md`'s
"Tool count: 67 registered tools" line — the doc's own inventory was written
against this same `v5.2.2` snapshot (its "Sources of truth" section cites
package.json `5.2.3`, but the note there flags the version string as a
`server.js` reporting quirk (D13); tag `v5.2.2`'s `tools.js` is what was
actually walked).

## Why not just read the current `pagespace-mcp` repo at test time

- **Auditability**: a git tag is immutable; importing the live repo at test
  time would make the parity gate's pass/fail depend on whatever that
  external repo happens to contain when the test runs — silently drifting
  ground truth is exactly the failure mode this gate exists to prevent.
  See `s5kfa3mc4boyjqrsfzvwocx4` (Phase 6 law): "commit the extracted list
  as a fixture."
- **No runtime dependency** on a second, unversioned local checkout existing
  at a specific path on whatever machine runs the test suite.

## Known delta: v5.2.2 → current `pagespace-mcp` HEAD (5.2.6)

`git diff v5.2.2 HEAD -- src/tools.js` (in the `pagespace-mcp` repo) shows
exactly 3 tools added since v5.2.2, none removed and no `required` fields
changed on any of the 67 tools that already existed at v5.2.2:

| Tool added after v5.2.2 | Status against the current SDK registry |
|---|---|
| `insert_lines` | Already covered — `pages.insertLines` |
| `delete_lines` | Already covered — `pages.deleteLines` |
| `set_home_page` | **Not covered** — no corresponding operation exists in `packages/sdk/src/operations/`. Out of scope for *this* v5.2.2-pinned gate (task 2's contract is v5.2.2, not 5.2.6), but worth a follow-up ticket before `pagespace-mcp` is fully retired, since a live 5.2.6 install has a capability this SDK doesn't yet expose. |

## Regenerating

```
cd /Users/jono/production/pagespace-mcp
git show v5.2.2:src/tools.js > /tmp/v522-tools.mjs
cd -
bun run packages/cli/src/mcp/__tests__/fixtures/extract-v5.2.2-tools.mjs /tmp/v522-tools.mjs \
  > packages/cli/src/mcp/__tests__/fixtures/v5.2.2-tools.json
```

Only re-run this if the `v5.2.2` tag itself is ever amended (it shouldn't
be — tags are supposed to be immutable) or if a future phase deliberately
re-pins the parity contract to a newer tag.
