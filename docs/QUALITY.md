# Quality Enforcement

How coding standards are *enforced* in this repo, not just written down. The
design principle (per Eric Elliott's school of software quality): **a standard
that isn't executable is an opinion.** Every standard here is either a lint
rule, a coverage threshold, or a counted metric — and every metric is a
ratchet: it may only move toward zero.

## The three gates

| Gate | What it enforces | Where | Fails CI when |
|------|------------------|-------|---------------|
| Per-package ESLint | Incident-driven rules (unbounded `findMany`, edge-runtime imports, stream-closure deps), import hygiene | `apps/*/eslint.config.mjs`, `packages/*/eslint.config.mjs` | Any error |
| Coverage ratchet | Line/branch/function/statement coverage per package | `*/vitest.config.ts` thresholds + `scripts/coverage-ratchet.mjs` | Coverage drops below locked threshold |
| **Quality ratchet** | The coding standard itself (see below) | `scripts/quality/` + `quality-baseline.json` | Any per-file per-rule count increases |

## The quality ratchet

`bun run quality` lints **every** `apps/*/src` and `packages/*/src` tree with
the strict rule set in `scripts/quality/eslint.quality.config.mjs` and compares
per-file, per-rule violation counts against the committed
`quality-baseline.json`. All debt that existed when the gate was introduced is
frozen in the baseline, so the gate is green today and fails only on **new**
debt.

The rule set maps 1:1 to stated standards:

- **No `any`** — `@typescript-eslint/no-explicit-any`, `ban-ts-comment`
  (`@ts-expect-error` requires a `: description`).
- **Pure functions, no input mutation** — `no-param-reassign` (including
  properties), `prefer-const`, `no-var`.
- **Small composable functions** — `complexity` ≤ 10, `max-depth` ≤ 4,
  `max-lines-per-function` ≤ 80, `max-params` ≤ 4, `max-nested-callbacks` ≤ 4.
- **No sloppy equality** — `eqeqeq` (the `== null` idiom is allowed).
- **No silent escape hatches** — every `eslint-disable` directive is counted
  as debt under `quality/eslint-disable-directive`. Inline config is *ignored*
  when measuring, so suppressing a rule doesn't hide the violation — it adds a
  second ledger line.

Key properties:

- **Per-cell granularity.** The unit is (file, rule). Fixing three `any`s in
  one file never buys headroom to add one somewhere else.
- **Deterministic.** Same tree → byte-identical baseline. `git log -p
  quality-baseline.json` is the complete, reviewable history of debt movement.
- **Tests are held to the standard too**, minus `max-lines-per-function` and
  `max-nested-callbacks` (suite structure, not function quality). `any` stays
  banned in tests — a test that lies about types proves nothing.

### Day-to-day

```bash
bun run quality          # what CI runs — fails on any regression
bun run quality:update   # rewrite the baseline to current state
```

- **You added a violation** → fix it. That's the point.
- **A violation is genuinely justified** → `bun run quality:update` and commit
  the baseline diff. The exception is then explicit in review instead of
  hidden in a suppression comment.
- **You cleaned something up** → `bun run quality:update` and commit; the
  lowered counts become the new ceiling and can never quietly regress.

### Driving a refactor with it

The baseline is the refactor tracker. To plan and measure a "make X clean"
effort:

1. Scope it: `node -e "const b=require('./quality-baseline.json');
   console.log(Object.entries(b.files).filter(([f])=>f.startsWith('apps/web/src/lib/ai')))"`
   — or just read the `files` map for the subtree.
2. Refactor until those entries hit zero; run `bun run quality:update` as you
   go. Each PR's baseline diff **is** the progress report — no judgment calls,
   no vibes, just counts.
3. Raising the bar repo-wide = tighten a limit or add a rule in
   `eslint.quality.config.mjs`, run `quality:update` once to absorb the newly
   visible debt, and burn it down the same way.

Current debt snapshot at introduction (2026-07): **2,708 items across 1,118
files** — dominated by `complexity` (1,097) and `max-lines-per-function`
(794). Those two are the honest map of where the major refactors are.

## Architecture of the gate itself

Functional core, imperative shell — the gate practices what it enforces:

- `scripts/quality/lib.mjs` — pure functions (count, diff, serialize, format).
  Tested in `scripts/__tests__/quality-gate.test.ts`.
- `scripts/quality/quality-gate.mjs` — I/O shell: runs ESLint, reads/writes
  the baseline, exits nonzero on regression.
- `scripts/quality/eslint.quality.config.mjs` — the rule set. Syntax-only
  rules by design (no type-aware linting) so the whole monorepo lints in one
  fast, project-config-independent pass.
