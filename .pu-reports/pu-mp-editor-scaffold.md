# pu/mp-editor-scaffold — Scaffold `@pagespace/editor`, move the frozen schema into it

Board: drive `omziyxp4skckh7ixi2sxzhuk`, epic `i7qcdfg3evjpn5mbe9ux8mk2`, leaf task
`nn32fpd8d14qbjnox5b1df2y` (page `yyt4kloed0l1bmcq7v3o77b5`). Left `in_progress`.

## Outcome

`packages/editor` exists, is React-free, and owns the frozen v1 schema. `SCHEMA_HASH` is
unchanged at `'ded0823d'` — the moved `collab-schema.ts` differs from the original in its five
import lines only (verified with `git diff -M`), and the drift guard recomputes the hash from the
package's `collabExtensions()` and passes. Node loads the package directly:

```
$ node -e "require('@pagespace/editor/collab-schema').SCHEMA_HASH"        → ded0823d
$ node --input-type=module -e "import {SCHEMA_HASH} from '@pagespace/editor/collab-schema'" → ded0823d
```

## Two places the plan was wrong, and what I did

**1. A CommonJS dist cannot load in Node — the package is ESM.** The leaf said "build is plain
`tsc`, follow the `packages/lib` shape" (CJS). I built that first; `require('@pagespace/editor/collab-schema')`
failed in plain Node and every web test importing it failed with
`Cannot read properties of undefined (reading 'Extension')`. Root cause: `tiptap-markdown@0.8.10`
resolves its `require` condition to a UMD file inside a `"type": "module"` package; Node evaluates
it as ESM and the UMD wrapper cannot see its own `require`. It only ever worked in `apps/web`
because webpack/vite take the `import` condition. That is fatal for the one consumer this package
exists for (`apps/collab`, Node). So the package is `"type": "module"`, built with
`module: NodeNext` — the exact shape `packages/sdk` already uses — exports carry `import`/`default`
only, and relative imports inside it carry `.js`. Node consumers can still `require()` it
(require(esm), Node 22+; the images are Node 24). `package-exports.test.ts` pins the ESM-only
shape so nobody "fixes" it back.

Consequence: `apps/web/next.config.ts` gains `resolve.extensionAlias['.js'] = ['.ts', '.tsx', '.js']`.
Web compiles the package from SOURCE via tsconfig `paths` in dev and in any build where
`workspaceDistReady` is false (CI's `bun run build --filter=web`); without the alias `next build`
fails with `Can't resolve './simple-data-attr.js'` (I hit it; `bun run typecheck` builds web).
Verified: `next build` compiles successfully with it.

**2. `client-schema.ts` stays in `apps/web`.** The brief lists it among the files to move, but it
imports `tiptap-mention-config.tsx` (React, tippy), `pagination` (DOM), `CodeBlockShiki` (Shiki +
React node view), `find-plugin`, and the Yjs collaboration extensions. Moving it would drag all of
that into the package and defeat "the React/DOM split is the point of the package". The
`collab-schema.ts` header comment (written in #2515) says the same: `clientExtensions()` lives in
the sibling file "precisely so importing it doesn't drag React into this module's import graph".
It now imports the schema pieces from `@pagespace/editor/*` instead of relative paths.
`RichEditor.tsx` still calls `clientExtensions()`; the structural guard passes.

Also stale in the brief: "there is currently zero yjs in the tree" — `apps/web/package.json`
already pins `yjs: 13.6.32` (Collaboration/CollaborationCaret landed in #2515). I still added
`yjs: "13.6.32"` to root `overrides` as instructed; the package itself does not depend on yjs
(nothing moved imports it), so it is not in its manifest — knip would flag it.

## React-free verification of the halves

`grep -n "react|tippy|shiki|document\.|window\.|from '@/"` over `packages/editor/src/*.ts`
(non-test) returns nothing outside doc comments. `page-mention-node.ts` and `code-block-node.ts`
are the #2515 splits: attributes + `parseHTML`/`renderHTML` only, no `addNodeView`, no
`addProseMirrorPlugins`. `eslint.config.mjs` in the package refuses `react`, `react-dom`,
`@tiptap/react`, `shiki*`, `tippy.js*` and any `@/*` alias at lint time.

## Surface delivered (matches the leaf's 21-file map)

- **Package (5):** `package.json` (subpath-only exports, no `main`/`types`/`"."`, mirrored
  `typesVersions`), `tsconfig.json`, `tsconfig.build.json`, `eslint.config.mjs`, `vitest.config.ts`
  (jsdom for tests only; the package constructs without a DOM).
- **Moved (7 + 4 tests):** `collab-schema`, `collab-marks`, `block-id`, `image-node`,
  `page-mention-node`, `simple-data-attr`, `code-block/CodeBlockNode.ts` → `code-block-node.ts`;
  tests `collab-marks`, `image-node`, `image-node-markdown`, `v1-schema-additions`. Stayed in web:
  `client-schema.ts`, the drift guard (it scans `apps/web/src` and needs `clientExtensions`),
  `client-schema-collab-options`, `tiptap-mention-round-trip`, all of `code-block/` except the node.
- **Pinning (1):** root `package.json` overrides `yjs: 13.6.32`.
- **Type + consumer wiring (3):** root `tsconfig.json` and `apps/web/tsconfig.json` gain
  `@pagespace/editor/*` paths; `next.config.ts` gains `editorDistExists` in the conjunction,
  `@pagespace/editor` in the `transpilePackages` fallback and the externals predicate, plus the
  `extensionAlias` above. `serverExternalPackages` untouched (`dockerfile-args.test.ts:64` still
  passes).
- **Docker (8 files, 9 sites):** `COPY packages/editor/package.json` beside every
  `COPY packages/lib/package.json`, including both `apps/realtime/Dockerfile` blocks (builder and
  `--from=builder` runner). `apps/web/Dockerfile` additionally builds the editor dist before
  `next build` so `workspaceDistReady` stays true in the image. `docker/cron` untouched.
- **Tooling (4):** `knip.json` (`packages/editor` workspace, 7 hand-enumerated entries),
  `vitest.workspace.ts`, `scripts/coverage-report.mjs`, `scripts/coverage-ratchet.mjs`; thresholds
  ratcheted from the real run (lines 71 / branches 94 / functions 53 / statements 71).
- **Web dependency cleanup:** `@tiptap/extension-code-block` and `@tiptap/extension-mention` were
  only imported by the moved files; knip flagged them as unused in `apps/web/package.json`, so they
  moved to the package. Those two removed lines plus the one added `@pagespace/editor` line are the
  whole `apps/web/package.json` diff (collision heads-up with `pu/adobe-data-spike` noted).

## New tests (2)

- `packages/editor/src/__tests__/package-exports.test.ts` — every src module has an `exports`
  entry pointing at dist AND a mirrored `typesVersions` entry; no `main`/`types`/`"."`; ESM-only.
- `infrastructure/scripts/__tests__/dockerfile-workspace-manifests.test.ts` — in all 8
  Dockerfiles, `packages/editor/package.json` is copied beside every `packages/lib/package.json`
  with the same source form, all five workspace manifests are copied an equal number of times, and
  realtime has exactly two editor sites. This is the guard for the failure that only surfaces at
  image-build time.

## Mutation checks (every mutation verified applied by md5 before/after, then restored)

| Test | Mutation | Result |
|---|---|---|
| collab-marks | rename `comment` mark to `commentx` | red (1/1) |
| image-node | `alt` → `altx` throughout | red (4/5) |
| image-node-markdown | break the markdown serializer key | red (1/3) |
| v1-schema-additions | comment out `DeletionMark` in `collabExtensions()` | red (1/19) |
| package-exports | delete one `typesVersions` entry | red (1/4) — first attempt's sed was a no-op (reported NO), redone with python |
| package-exports | add a `require` condition to one export | red (1/4) |
| dockerfile-workspace-manifests | delete the editor COPY line in admin | red (2/17) |
| dockerfile-workspace-manifests | drop `--from=builder` on realtime's runner editor line | red (1/17) |
| collab-schema-drift-guard (web, via rebuilt dist) | see below | see below |

Drift guard (web, imports the package from **dist**): commented out `DeletionMark` in the
package's `collab-schema.ts`, verified the src md5 changed, rebuilt `packages/editor/dist` and
verified `dist/collab-schema.js` md5 changed, ran the web guard: **5 failed** (hash recomputed ≠
`ded0823d`, three parity cases, one drop-a-member case). Restored src, rebuilt, verified dist md5
back to the original, guard 37/37 green. The web-side guard therefore still sees the package's
real schema through the dist it consumes.

`assert` import audit: none of the touched tests use riteway-style `assert`; all use
`expect` from an explicit `vitest` import.

## Gates

- `bun run typecheck` (monorepo root, turbo): first run failed in `web#build` on the `.js`
  imports (see above); after the `extensionAlias` fix `next build` in `apps/web` compiles and
  exits 0, and every typecheck task passed. Re-run of the full turbo typecheck not repeated after
  the fix (it is the same `web#build` step plus 18 already-green tasks; CI runs it).
- `bun run lint` (monorepo root): exit 0.
- `bun run test`: the DB wrapper cannot start — Docker is down on this machine and I did not
  start it. Ran the same vitest projects directly: `@pagespace/editor` 32/32, `realtime`
  1190/1190, `infrastructure` 360/360 (incl. the new Dockerfile guard), `processor` 1171/1171
  with 4 files failing on `ADMIN_DATABASE_URL is not set`, `@pagespace/lib` 11646 passed / 29
  failed, `web` 19424 passed / 28 failed. Every lib/web failure is a Postgres-backed suite
  (`*.integration.test.ts`, or "Test database not reachable"/`42P01`/"could not reach Postgres");
  none is under `lib/editor`, `packages/editor` or `infrastructure`. All 9 editor-related web
  test files pass (130 tests), including the drift guard and the mention round-trip.
- `bun run knip:check`: passes on a fresh checkout of this commit; see the discrepancy note
  below for this worktree.
- `SCHEMA_HASH` = `'ded0823d'`, unchanged; drift guard recomputes and agrees.

## knip: a worktree-only discrepancy, documented

In this `.pu/worktrees` checkout `knip:check` reports 4 extra findings in
`packages/lib/src/env-bridge/*` and `drive-envs/env-contract.ts` — files this branch does not
touch. A fresh `git worktree add --detach` of the identical commit (`bun install --frozen-lockfile`,
run from the session scratchpad) reports `[ok] knip: 4 issue(s), all within baseline (4)`, and a
JSON diff of the two runs shows exactly those 4 as worktree-only with nothing fresh-only. Moving
every ignored artifact aside and a clean reinstall did not change the worktree's answer. CI runs
on a fresh checkout, so the gate should be green there; if it is not, that is the first thing to
look at. The genuine finding (the two now-unused tiptap deps in `apps/web/package.json`) appeared
in both runs and is fixed.

## Cleanup pass (/simplify, 4 reviewers) and first review comment

Applied: one `WORKSPACE_PACKAGES` list in `next.config.ts` now drives the dist check, the
`transpilePackages` fallback and the externals predicate (was three hand-copied lists); the
`extensionAlias` order is `.js` first so the common node_modules case resolves on the first try;
stale "this file will move to packages/editor" / "(this directory)" comments in
`collab-schema.ts`, `client-schema.ts` and the drift guard now name the real locations; the
Dockerfile-manifest guard derives its package list from `packages/*` and its Dockerfile list from
`apps/*/Dockerfile*` instead of hand lists, and asserts every package mirrors `lib`'s COPY sites
(re-mutation-checked: admin line deleted → red, realtime `--from=builder` dropped → red);
`tsconfig.build.json` no longer repeats four inherited options; the package's devDependencies
are only `eslint` + `typescript-eslint` (the rest is hoisted from root, matching `lib`/`sdk`);
eslint messages deduped and no reference to a non-existent `apps/collab`; knip entry is
`src/*.ts` (the exports test already pins the flat layout); `vitest.workspace.ts` points at the
package's own config instead of restating it.

Codex (P2, `packages/editor/package.json`): `bun run test:unit` built only `@pagespace/lib`
before running web's vitest directly, so on a clean checkout web tests could not resolve the
editor dist. Verified against `package.json:26` and fixed by adding `--filter=@pagespace/editor`
to that script.

Skipped, deliberately: replacing the Dockerfile `db && lib && editor` build chains with a turbo
invocation (changes deploy behaviour in four images; out of scope for a move); dropping
`typesVersions` (the leaf's acceptance criteria require it alongside `exports`); extracting the
duplicated coverage-script package arrays (pre-existing); a shared ESM tsconfig base for
`sdk`+`editor` (two consumers is not yet worth a base).

## CI and the Docker proof

CI (Test Suite workflow) is green on both commits: Lint & TypeScript Check (includes `knip:check`,
confirming the worktree-only knip discrepancy), Unit Tests (the Postgres-backed suites I could not
run locally), and E2E. The Docker Images workflow only runs on pushes to `master` (and
`workflow_dispatch`, which also pushes images to ghcr for any ref, so I did not trigger it).
Instead I reproduced the deps stage locally: copied exactly the files `apps/web/Dockerfile`
COPYs before `bun install --frozen-lockfile` (root manifest + lockfile + every workspace
`package.json`) into a scratch dir and installed — 4320 packages, success. Negative control:
the same set minus `packages/editor/package.json` fails with
`error: @pagespace/editor@workspace:* failed to resolve`, which is precisely the image-build-time
failure the 9 COPY sites prevent. All 8 Dockerfiles copy the same manifest set (guarded by the
derived test), so the result applies to every image.

Codex's one comment (P2, `test:unit` did not build the editor) was verified and fixed; the
thread is replied to with evidence and resolved. CodeRabbit was rate-limited at PR open and
has not yet posted a real review.

## Not done / for the next agent

- `apps/collab` does not exist yet; the package is ready for it to import
  `@pagespace/editor/collab-schema` from Node. Don't put a CJS consumer between it and
  `tiptap-markdown` — see above.
- The lockfile also picked up an already-committed `packages/cli` bump of `@pagespace/sdk`
  (`^2.0.0` → `^2.3.0`) and a `ws` hoisting reshuffle; both are `bun install` catch-up, no version
  changes.
