# Review: PR #1900 (pu/trm-pricing → pu/terminal) — Terminal Epic 3, Pricing node

Recorded here because the named PageSpace page `sf0ojnmxrc9zmni59rrkriug` returned
404 (Page not found) to this agent's `pagespace` MCP connection on two attempts,
and a `multi_drive_search` across all 3 accessible drives (pagespace,
ai-agent-hub, aidd-agents) found no match either — this worktree agent's MCP
session doesn't have visibility into whatever drive that page lives in. Falling
back to the repo review log per aidd-review's Recording{} fallback rule. Please
re-run recording against the PageSpace page once access/ID is confirmed.

Reviewed files (full diff vs `origin/pu/terminal`):
- `packages/lib/src/billing/credit-pricing.ts`
- `packages/lib/src/monitoring/terminal-pricing.ts`
- `packages/lib/src/monitoring/__tests__/terminal-pricing.test.ts`
- `packages/lib/src/services/sandbox/__tests__/machine-billing.test.ts`

`npx aidd churn --top 20` — none of the 4 touched files appear in the top-20
hotspot list (dominated by `apps/web/src/app/api/ai/chat/route.ts` and other
large route/component files). This diff avoids known hotspots — lower risk.

`bun run typecheck` (full monorepo) — 16/16 turbo tasks green.
`bunx vitest run` on `packages/lib/src/{billing,monitoring,services/sandbox}` —
54 files / 1119 tests pass. `apps/realtime/src/terminal` — 6 files / 124 tests
pass. Lint clean (`bun run --filter '@pagespace/lib' lint`). `knip --include
exports` does not flag the new exports as unused (test-only usage is enough
for its config), but see Finding 3 below.

## Findings

- [ ] MAJOR · `packages/lib/src/monitoring/terminal-pricing.ts:65` · `calculateTerminalChargeCents` computes the "1.5x floor" charge but is never called by the actual settle path — `machine-billing.ts`'s `trackUsage` still hands `calculateTerminalCostDollars(...)` (pre-markup) to `AIMonitoring.trackUsage`, and the real ledger charge is computed generically by `consumeCredits` via `chargeMillicents(costDollars, MARKUP_BPS)` (`credit-consume.ts:181`), which has no independent per-source floor. So the PR's own "floor" function is a disconnected shadow calculation that happens to match production today only because both read the same `MARKUP_BPS` default — if that shared constant is ever tuned down for another billing surface (e.g. a chat/voice promo), terminal's real settled charge would silently drop below 1.5x with nothing in production to catch it. What correct looks like: either wire `calculateTerminalChargeCents` (or an equivalent) into the actual settle path so the floor has real teeth, or re-scope the PR description/acceptance to state plainly that the floor is enforced only by the shared global `MARKUP_BPS` today (no independent protection), so a future reader doesn't mistake this pure function for the authoritative charge path. Compounding risk: `calculateTerminalChargeCents` rounds to whole cents via `markupCents`, whereas the real settle path (`chargeMillicents` + `accruePending`) intentionally carries sub-cent fractions forward so short runs are never silently written off at $0 — if a future engineer wires this "authoritative-sounding" function directly into a ledger write (its name and docstring both suggest it's *the* charge calculator), sub-second terminal runs would be under-billed to zero instead of accruing.
- [ ] MINOR · `packages/lib/src/monitoring/__tests__/terminal-pricing.test.ts:59` · The "enforces the 1.5x floor" test doesn't actually exercise floor/max behavior. `MARKUP_BPS` is a fixed import-time constant the test can't vary, so `expect(chargeCents).toBeGreaterThanOrEqual(Math.floor(cost * 1.5 * 100))` reduces to `round(x) >= floor(x)`, which is true for any positive `x` regardless of whether a real floor mechanism exists — it would still pass even if `calculateTerminalChargeCents` applied a lower, hard-coded multiplier by mistake (as long as that multiplier were still ~1.5x). What correct looks like: either drop the "floor" framing from the test name/comment (it's really just a formula-consistency check), or make the floor genuinely testable — e.g. parameterize the effective markup bps so a test can assert `max(globalBps, floorBps)` behavior directly.
- [ ] MINOR · `packages/lib/src/monitoring/terminal-pricing.ts:76` · `calculateTerminalStorageCostDollars` + `TERMINAL_STORAGE_USD_PER_GB_MONTH` have zero production consumers — both are only exercised by their own colocated test. This is explicitly requested by the task's acceptance criteria ("storage rate" constant), so it's not wrong, but the full pure-function calculator is speculative ahead of the not-yet-scheduled idle-storage cron PR (Epic 3). What correct looks like: if the follow-on cron PR is imminent, this is fine as staged groundwork; if it isn't scheduled, consider landing just the constant (as literally asked for) and letting the cron PR add the calculator alongside its first real caller.
- [ ] NIT · `packages/lib/src/billing/credit-pricing.ts:167` · The `TERMINAL_STORAGE_USD_PER_GB_MONTH` docblock says storage is "not by the active-runtime charge in terminal-pricing.ts" — slightly ambiguous now that a storage-cost helper (`calculateTerminalStorageCostDollars`) also lives in that same file. Naming `calculateTerminalCostDollars` explicitly instead of the whole file would remove the ambiguity.

**Verdict: 1 major / 2 minor / 1 nit; 0 fixed (review-only pass, no code changes made per review constraints).**
