# Terminal — grounding spec

Canonical requirements + file paths for the three Terminal epics. The PageSpace board (Features → Terminal — Agent Comms / Terminal — Workspace / Terminal — Metering) holds the runnable task tree; each PR-node page is the executable spec and cites this file. Orchestration follows the `orchestrating-an-epic` PageSpace skill (four-layer board, `/aidd-review` recording to `## Findings`, PR ralph-loop convergence to PR_READY, CI-green-before-merge).

## Model (settled)

- **Terminal** — the top-level surface/product (right-sidebar workspace; long-term: files left / splittable terminals middle / navigator right = Projects(git) → Branches(docker) → terminals(agent sessions), PurePoint-shaped). A Terminal is page-backed.
- **Machine** — the substrate a Terminal runs on. Sprite today, Modal for beefy/GPU later. Abstracted behind a substrate seam; never a user-facing tier. Persistent + installable: hibernates, filesystem preserved. The value over throwaway code-exec is "my tools are already installed."
- **Agents use Terminals.** Global assistant + page agents reference a Machine and run their code-exec tools there. Multiple machines: the agent holds an ACTIVE machine as state and moves between them with a `switch_machine` tool; a `list_machines` tool (mirrors `list_pages`) reports its configured machines + which is active + an optional description. The agent is BLIND to warm state — no running/hibernated exposed; waking is transparent on switch/use.
- **Scope = page permissions.** A Terminal/Machine is a resource governed by page access — no per-drive/per-user scoping model. (The earlier "Sandboxes Per Drive" rearchitecture is abandoned; this replaces it.)
- **Billing:** meter Machine active runtime at a floor of 1.5× actual substrate cost through the credits pipeline, to the owner.

## Current reality (grounding)

- AI code-exec runs in a **throwaway per-conversation** Sprite: `packages/lib/src/services/sandbox/session-manager.ts` (`sandbox_sessions`), tools in `apps/web/src/lib/ai/tools/sandbox-tools.ts` + `sandbox-tools-runtime.ts` (`resolveSandboxActorContext` ~196–281) + `sandbox-git-tools.ts`, registered in `apps/web/src/lib/ai/core/ai-tools.ts` behind `isCodeExecutionEnabled()`.
- Terminal pages run a **persistent per-page** Sprite but human-PTY-only: `terminal_sessions`, `packages/lib/src/services/sandbox/terminal-session-manager.ts`, realtime PTY in `apps/realtime/src/index.ts` (`makeTerminalCheckAuth`), UI `apps/web/src/components/layout/middle-content/page-views/terminal/TerminalView.tsx`. Same `@fly/sprites` driver (`sandbox-client/sprites.ts`), containment (`containment.ts`, `FULL-EGRESS-ENABLEMENT.md`).
- Both keyed via `session-key.ts`. Epic 1's core is unifying these: agents run in the terminal's persistent machine.
- Page-agent config: `apps/web/src/components/ai/page-agents/PageAgentSettingsTab.tsx` (top toggles `includeDrivePrompt`/`includePageTree`/`visibleToGlobalAssistant` ~438–553; flat Default Tools list `enabledTools`/`availableTools` ~677–743). Config model `apps/web/src/lib/repositories/page-agent-repository.ts` (`PageAgentConfig` ~190–205), API `apps/web/src/app/api/pages/[pageId]/agent-config/route.ts`. There is NO terminal/sandbox toggle today — sandbox tools just appear in the flat list when code-exec is globally on.
- Permissions: `packages/lib/src/permissions/agent-permissions.ts`, `packages/lib/src/services/sandbox/can-run-code.ts`.
- Credits pipeline (metering): `packages/lib/src/billing/credit-gate.ts` (`canConsumeAI`), `credit-consume.ts` (`consumeCredits`/`releaseHold`), `credit-pricing.ts` (`MARKUP_BPS` = 1.5× precedent), `packages/lib/src/monitoring/ai-monitoring.ts` (`trackUsage`), voice recipe `apps/web/src/app/api/voice/transcribe/route.ts` + `voice-pricing.ts`.

## Epics (PR-node lists live on the board; specs on each PR-node page)

**Epic 1 — Agent ⇄ Terminal communication** (ship first): config model (`terminalAccess` default off + `machines[]`); terminal tools + `switch_machine` + `list_machines` (active-machine, blind to warm state); route tools to the active machine (unify sandbox/terminal session); PageAgentSettingsTab surface (toggle gates tools + machine selection: own / existing / add multiple); permissions + activity-visibility + minimal runtime guardrail; global-assistant parallel (same flow, user-level settings).

**Epic 2 — Terminals as the agent workspace**: isolation = **git worktrees, not docker** — a PageSpace agent spawning terminals, each in its own worktree (branch checked out in its own dir, PurePoint's actual model; Sprites support it natively), IS the isolation layer. PR nodes: machine-substrate abstraction (Sprite now; Modal/GPU later, NOT a hard prereq); Projects tier (git repos per machine); Branches tier (git worktree per branch — no docker); Runtime (agent spawns multiple terminals across worktrees, pluggable agent type — pagespace-cli/claude/codex); UI (3-panel IDE); live per-worktree diffs. (PROBE PR #1889 settled it: docker isn't viable on raw Sprites + Modal isn't set up → worktrees route around both; docker/Modal remains a future option only for isolating distrusting parties on one machine.)

**Epic 3 — Metering**: Machine active-runtime metering (hold→settle, `source:'terminal'`, voice recipe); pricing 1.5× floor + constants; owner-pays resolution + idle-storage cron; usage surface. A minimal runtime guardrail ships in Epic 1 (T1.5) so persistent agent usage isn't unbounded before full billing.

## Build mandate

Greenfield within the app — code-exec is admin-only + flag-off (`CODE_EXECUTION_ENABLED` default OFF), no released consumers. No backwards-compat shims; delete the throwaway per-conversation path when unifying. Pure functions + DI, thin shells; test-first TDD; bun only; no `any`; Next 15 params awaited; migrations via `bun run db:generate`; permissions only via `packages/lib/src/permissions/`; tests colocated in `__tests__/`. User-facing noun is "Terminal" / "Machine"; never name Fly/Sprites/Modal in UI copy.
