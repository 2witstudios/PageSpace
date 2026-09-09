# PageSpace Dev — Design Spec

**Status:** Mock UI phase (no backend). This document is the north star for the `apps/dev` app.

## 1. What this is

PageSpace Dev abstracts the PageSpace `/development` surface into its own standalone Next.js app.
It is **PurePoint rebuilt for the cloud**: PurePoint's UI and concept (spawn parallel AI coding
agents, watch them, gate them, converge their work) — but instead of local git worktrees on one
laptop, agents run in **cloud workspaces** (PageSpace machines/Sprites). The `/development` page
inside the dashboard is not replaced; this app is its own front door for the same mental model.

### Vocabulary (PurePoint-native, kept on purpose)

| Term | Meaning here |
|---|---|
| **Agent** | One AI coding session (Claude, Codex, or a plain terminal) running in a cloud checkout |
| **Workspace** | A cloud machine — the substrate agents run on. Owns repos and branches |
| **Checkout** | A repo + branch pair on a workspace (the cloud analog of a worktree) |
| **Point guard** | A root agent that orchestrates other agents rather than writing code |
| **Spawn** | Create an agent into a checkout (split-and-pick: the pane and the agent are one act) |
| **Pulse / Fleet** | The at-a-glance dashboard: every agent, status, runtime, diff stats |
| **Bench / Play** | Suspend / resume an agent without killing it |
| **Trigger** | Event → ordered inject/gate sequence (`agent_idle`, `pre_commit`, `pre_push`) |
| **Gate** | A command that must pass before the next step (tests, lint) |
| **Schedule** | Spawn an agent at a time, optionally recurring |
| **Swarm** | A named roster of agents spawned together |
| **Template** | A saved, variable-interpolated prompt (`{{BRANCH}}`) |

## 2. What we learned from the existing surfaces

From **`/development` in apps/web** (keep these patterns):

- **Sidebar-as-content**: the left sidebar IS the surface — an aggregated tree
  (Machine → Project → Branch, with session leaves), global and scoped modes. The detail pane
  is secondary; its empty state says "pick from the sidebar."
- **Machine detail = 4 tabs**: Terminal / Files / Diff / Settings. Only the active tab mounts.
- **Terminal = workspace pane grid**: resizable split panes (`react-resizable-panels`), each pane
  hosts one agent terminal; split-right/split-down/close per pane; an agent picker fills empty panes
  (split-and-pick — spawning is choosing an agent type + optional first prompt, never naming).
- **Diff tab**: navigation tree beside a 3-scope toggle (Uncommitted / Committed / Branch vs
  default), then cheap per-file header rows that expand into diff bodies on demand.
- **Selection ≠ expansion**: tree rows decouple select (navigate) from expand (disclose); rows
  that don't navigate keep expand-on-label-click.
- **Keep-alive**: switching agents must not tear down terminals (mock phase: keep pane state in a
  client store keyed by agent id, never unmount on route change within the shell).

From **PurePoint (`pu`)** (the concept set the UI must carry):

- Fleet awareness: `pu pulse` / `pu watch` → a live dashboard is the home screen, not a file tree.
- Agent lifecycle: running / waiting (idle at prompt) / broken (exited) — plus benched.
- Cross-agent diff: one view over every agent's changes (`pu diff`), not just per-machine.
- Automation as first-class UI: triggers with gate sequences and retries, schedules with
  recurrence, agent/swarm definitions, prompt templates.
- The orchestration stance: the user is the point guard; the UI is their courtside view.

## 2.5 The unlock: task-driven orchestration

PurePoint's unit of work is a one-shot prompt. PageSpace's is a **task board** — and that board
is what PageSpace Dev exists to execute. Everything below uses the REAL task model
(`packages/db/src/schema/tasks.ts` + the apps/web task-list views), not an invented one:

- **Tasks ARE prompts.** A task is a `task_items` row backed by a DOCUMENT page that owns its
  title and body; the body's `## Spec` ("Given X, should Y") is the agent's brief. Spawning from
  a task and typing a prompt are the same act at different altitudes.
- **Nesting is the page tree.** A task's page contains child TASK_LIST pages — that's how
  Epic → Phase/PR → Named task → RED/GREEN layers exist today (`subTaskCount`, `canExpandTask`).
  There is no children array; the hierarchy IS pages.
- **Parents are gated on children — already enforced.** The real board refuses to complete a
  task with open sub-tasks ("Finish N sub-tasks first"). PageSpace Dev keeps that behavior
  verbatim; it doesn't invent a gate object.
- **Statuses are per-list configs.** slug/name/color/position with a system `group`
  (todo | in_progress | done). Defaults: To Do / In Progress / Blocked / Done; lists customize
  (e.g. an In Review column). Kanban columns are the status order.
- **Assignment is the agent edge.** `taskAssignees` already holds users AND agent pages; a cloud
  session working a task is an assignee (rendered with its live status dot). Advancement gating
  ("point guard approves before the next phase unblocks") is expressed with what exists:
  Blocked status + task triggers/workflows on status change — not a new mechanism.
- **Leaves can loop.** A loopable task (ralph-loop style; `metadata` + an agent-idle workflow)
  respawns its session until its acceptance condition passes — "iterate until the coverage
  ratchet exits 0" — with the iteration count visible.

Everything else in the app (fleet, workflows, calendar) is instrumentation around this loop.

## 2.7 Two hierarchies, joined asynchronously

The complication PurePoint never had: **where work is defined and where it executes are
different trees**, and nothing structural ties them together.

```
Definition:  drive → page tree → TASK_LIST page → task (→ its page → nested lists…)
Execution:   machine → project (repo) → branch → session (terminal)
```

- A **machine is itself a page** in some drive — but that's its *address*, not its scope. A
  session on a PageSpace-drive machine can work a task from the pagespace-cli drive (the mock
  ships exactly this case).
- The ONLY join is **assignment, made at spawn time**: picking a task and picking a checkout are
  two independent choices in the same spawn act. Task → checkout is many-to-many over time.
- The join is **async**: task status changes and session lifecycle events happen on different
  clocks. An agent can outlive its task (moved to Done, session keeps running) and vice versa
  (session killed, task stays In Progress). The UI must treat the edge as data that can dangle,
  never as containment.
- Consequence for every surface: an agent always shows BOTH coordinates — its task (drive
  terms) and its checkout (machine terms) — side by side, and neither tree renders the other's
  nodes as children. The fleet rail groups machines under drive headers (their address, matching
  DevelopmentSidebar's global mode); the Tasks surface groups boards under drive headers; the
  edge between them is chips, not nesting.

## 2.6 PageSpace primitives, not parallel ones

Where PurePoint invented a concept, PageSpace usually already has the primitive. This app reads
the platform's, and the mock is shaped accordingly:

| PurePoint concept | PageSpace primitive | In this app |
|---|---|---|
| Prompt / spec | **Task** (spec = acceptance criteria) | Tasks surface; spawn-from-task; agent moves the task |
| Trigger + gate sequence | **Workflow** (`executeWorkflow`) | Workflows tab; `task_status` joins `agent_idle`/git events |
| Schedule | **Calendar event + calendar trigger** | Calendar tab; also visible on the drive calendar |
| Prompt template | **Command** (parameterized prompt) | Command picker in the Spawn dialog |
| Agent def | **AI_AGENT page** (model + prompt config) | Future: spawn an instance of a drive agent |
| Swarm def | A workflow that spawns N agents | Future: no standalone concept |
| Workspace | **MACHINE page** | Workspaces surface (backend phase binds them) |
| "waiting on input" | **Mentions / notifications / channels** | Future: the agent's question pages you |
| Durable output | **Pages** (plans, reports, activity log) | Future: scrollback is transient, pages are not |

`Library` was dropped for exactly this reason: its three halves (templates / agent defs / swarm
defs) all dissolve into existing primitives.

## 3. Information architecture

Standalone app shell (no dashboard chrome). Left rail + content pane.

```
/                      Assistant — the global chat landing (mirrors the PageSpace dashboard)
/fleet                 Fleet — the pulse dashboard
/tasks                 Tasks — real PageSpace boards (nested, gated, loopable)
/agents/[agentId]      Agent detail — Terminal · Diff · Files · Settings tabs
/workspaces            Cloud workspaces list (machines, repos, branches, usage)
/workspaces/[wsId]     One workspace — its checkouts + agents
/diff                  Cross-fleet diff — every agent's changes in one view
/workflows             Workflows (event-driven) · Calendar (scheduled spawns)
/settings              App preferences (theme, defaults, tokens — mock)
```

### Shell layout

```
┌──────────┬──────────────────────────────────────────────┐
│          │  Top bar: breadcrumb · ⌘K spawn · theme      │
│  Left    ├──────────────────────────────────────────────┤
│  rail    │                                              │
│          │   Routed content pane                        │
│  nav +   │                                              │
│  fleet   │                                              │
│  tree    │                                              │
└──────────┴──────────────────────────────────────────────┘
```

- **Left rail** (`liquid-glass-regular`, ~288px, collapsible): primary nav (Fleet, Workspaces,
  Diff, Automations, Library, Settings) above a **fleet tree** — Workspace → Repo → Branch →
  agent leaves with status dots. Clicking an agent leaf routes to `/agents/[id]`; branch/repo rows
  expand only (selection ≠ expansion, exactly like `MachineTree`). Each row hover-reveals a `+`
  (spawn here) — the `NodeActionPalette` pattern.
- **Top bar**: current location breadcrumb, a **Spawn** button (primary CTA, opens spawn dialog),
  and a theme toggle. Spawn is also ⌘K.

## 4. Screens

### 4.0 Assistant (`/`) — the landing

The front door is a **global assistant chat**, mirroring the PageSpace dashboard (whose middle
pane at `/dashboard` is `GlobalAssistantView`) — the fleet is one click away, not replaced.

- **Header mirrors the AI page (`AiChatView`), not the dashboard's sidebar wiring**: a
  Chat · History TabsList on the left — **History is a middle tab, never a right-sidebar
  panel** — with per-tab actions on the right (Chat tab: agent selector, Activity toggle, New).
- **Agent selector**: Assistant, or any fleet agent with its live status dot — asking a
  specific agent is the chat form of `pu send`.
- **Chat tab**: centered "How can I help you today?" + composer + fleet-grounded suggestion
  chips until the first message (ChatLayout's centered-input behavior), then a docked
  conversation — user bubbles right, assistant rows left with a spark avatar.
- **History tab**: past conversations as cards (title, last-message snippet, age, count);
  clicking one loads it into the Chat tab.
- **Activity**: the one sidebar-worthy thing — the Activity button toggles a right-side
  **fleet activity feed** panel (spawns, status changes, task moves, gates, sends), scoped to
  this surface.
- The real version is the orchestration conversation: fleet/tasks/diffs as context,
  spawn/send/bench as tools — the point guard as a chat you talk to. Mock replies are canned
  and keyword-matched to the fixtures so the demo conversation stays believable.

### 4.1 Fleet (`/fleet`) — the pulse

The `pu watch` dashboard as a page.

- **Stat row** (4 cards): Agents running · Waiting on input · Broken · Benched. Waiting is the
  attention number — accent-colored when > 0.
- **Agent cards grid** (responsive, 1–3 cols). Each card:
  - Status dot (running=success pulse, waiting=warning, broken=destructive, benched=muted)
  - Agent name + runtime badge (Claude / Codex / Terminal)
  - Checkout line: `workspace / repo @ branch` (mono)
  - Diff stat chip: `+245 −38 · 12 files`
  - Last output snippet (1–2 lines, mono, muted — the `pu logs` tail)
  - Age ("running 42m") and quick actions: Open · Send · Bench/Play · Kill (destructive, confirm)
- **Point guard strip** (if a root agent exists): pinned full-width card above the grid.
- Filter chips: All / Running / Waiting / Broken / Benched; sort by activity.
- Empty state: big spawn CTA — "No agents in flight. Spawn your first."

### 4.2 Agent detail (`/agents/[agentId]`)

Header: status dot, name, runtime badge, checkout path, bench/play + kill buttons.
Tabs (same four as MachineView, same order): **Terminal · Files · Diff · Settings**.

- **Terminal**: the pane grid. `ResizablePanelGroup` with nested horizontal/vertical splits.
  Each pane: mono mock scrollback (realistic agent transcript), pane header with session name +
  close, hover-revealed split-right/split-down controls, and a prompt input row at the bottom
  (`pu send`). Empty pane shows the **agent picker** (Claude / Codex / Terminal + optional first
  prompt) — split-and-pick.
- **Files**: read-only tree + file viewer mock (few files, syntax-tinted mono block).
- **Diff**: scope toggle (Uncommitted / Committed / Branch vs default) + expandable per-file
  cards with mock unified diff rows (green/red tinted lines, mono). Empty scopes use the precise
  wording pattern from DiffTab ("No committed changes on `branch`").
- **Settings**: agent name, runtime, checkout, trigger opt-out switch, danger zone (destroy).

### 4.3 Workspaces (`/workspaces`, `/workspaces/[wsId]`)

- List: card per cloud workspace — name, region/size chip, repos count, running-agents count,
  storage/usage meter (mock), status (ready/booting/stopped).
- Detail: repo → branch checkout tree with agent counts per branch, "Add repo" / "Add branch"
  affordances (dialog mocks), and the workspace's agents in a compact table.

### 4.4 Cross-fleet Diff (`/diff`)

`pu diff` for the cloud: left column lists agents-with-changes (name + diff stat); right pane
shows the selected agent's file cards (same component as agent Diff tab). A "stat only" toggle
mirrors `pu diff --stat`.

### 4.5 Tasks (`/tasks`)

Real PageSpace boards (§2.5), grouped under drive headers (§2.7). Each section is one
TASK_LIST page rendered with the actual board grammar:

- **Rows**: checkbox · expand chevron (`canExpandTask`: content or sub-tasks) · title
  (line-through when done-group; click opens the task's page) · `completed/total` sub-count ·
  trigger ⚡ count · assignee chips · priority chip · **status chip** (colored per the list's own
  status configs; click to change).
- **List / Board toggle** — kanban columns come from the list's status order, per list.
- **Expansion opens the task's page**: its spec body, then its nested TASK_LIST pages rendered
  recursively (each with its own title and status configs).
- **The completion gate works**: checking a parent with open sub-tasks refuses with
  "Finish N sub-tasks first" — same behavior, same wording as the real board.
- **Assignees are the agent edge**: user chips, agent-page chips, and session chips (live status
  dot, links to the agent). Loop badges (`loop 3`) mark ralph-loop tasks.

### 4.6 Workflows (`/workflows`)

Two tabs, both PageSpace primitives (§2.6):

- **Workflows**: card per workflow — name, event badge (`task_status` / `agent_idle` /
  `pre_commit` / `pre_push`), sequence rendered as ordered inject chips and gate steps with
  retries. Enable/disable switch.
- **Calendar**: calendar events carrying agent-spawning triggers — next run, recurrence, spawn
  mode. They live on the drive calendar too; this is a filtered view, not a second scheduler.

### 4.7 Settings (`/settings`)

Mock: default runtime, default workspace size, theme, API token placeholder row.

## 5. Visual language

- **Tokens**: copied from `apps/web/globals.css` — the full oklch light/dark palette, radius
  scale, material system (`--material-*`, `liquid-glass-*` utilities), `--separator`, shadows.
  PageSpace Dev must feel like PageSpace, not a new brand.
- **Type**: Geist Sans UI, **Geist Mono everywhere the fleet speaks** — checkout paths, log
  tails, diff bodies, terminal panes. The mono-density is what makes it read as a dev tool.
- **Status colors**: `--success` running · `--warning` waiting · `--destructive` broken ·
  `muted-foreground` benched. Dots, not filled badges, at rest; the waiting state may pulse.
- **Density**: sidebar rows `text-sm`/`py-0.5` like `MachineTree`; cards are compact; this is a
  cockpit, not a marketing page.
- **Dark-first**: default theme dark (terminals live there); light fully supported.

## 6. Component plan

**Copied verbatim from `apps/web/src/components/ui`** (stay drop-in compatible):
`button`, `badge`, `card`, `tabs`, `scroll-area`, `separator`, `input`, `label`, `textarea`,
`select`, `switch`, `dialog`, `alert-dialog`, `dropdown-menu`, `tooltip`, `resizable`,
`skeleton`, `table`, `sonner` + `lib/utils.ts` (`cn`).

**New, app-owned** (`src/components/`):

- `shell/` — `AppShell`, `LeftRail`, `PrimaryNav`, `FleetTree` (the MachineTree pattern:
  TreeRow with decoupled select/expand, hover extras), `TopBar`, `ThemeToggle`
- `fleet/` — `StatCards`, `AgentCard`, `AgentStatusDot`, `RuntimeBadge`, `DiffStatChip`,
  `FilterChips`
- `agent/` — `AgentHeader`, `TerminalPaneGrid`, `TerminalPane`, `MockScrollback`,
  `AgentPicker`, `PromptInput`, `FilesMock`, `DiffScopeTabs`, `DiffFileCard`, `AgentSettings`
- `tasks/` — `TaskTree` (recursive: status icons, spec lines, gate rows, loop badges, agent
  chips, hover Spawn/Iterate)
- `spawn/` — `SpawnDialog` (⌘K): **ground-on-task picker first** (picking one fills the prompt
  with its spec), free prompt textarea, runtime picker, drive-command picker, checkout cascade,
  plan-mode switch. Names auto-minted.

**Mock data** (`src/lib/mock/`): typed fixtures — `workspaces.ts`, `agents.ts`, `tasks.ts`,
`diffs.ts`, `automations.ts`, `commands.ts` — plus `types.ts`. All screens read from these; UI
state stays in component state so interactions feel real. No fetches. Agents carry `taskId`;
tasks carry `agentId`, `gate`, `loop` — the orchestration edges are in the data model from day
one.

## 7. App structure & parity

Follows `apps/admin` (the cleanest sibling): same `src/app` + `src/components` + `src/lib`
layout, same script names (`dev`/`build`/`start`/`lint`/`typecheck`), Tailwind 4 via
`@tailwindcss/postcss`, Geist via `next/font/google`, `next-themes`. Differences:

- **Next 16** (`next@16.x`, async `params` everywhere, `next lint` gone → `eslint` CLI directly).
- Port **3006** (`web` 3000, marketing 3004, admin 3005).
- No `@pagespace/db` / `@pagespace/lib` deps yet — mock phase is dependency-light on purpose;
  they arrive with the backend phase.

## 8. Out of scope (this phase)

Real terminals (xterm/socket), real git/diff data, auth, billing/metering, the cloud-agent
control plane, mobile layouts beyond simple responsiveness, tests for mock fixtures.

## 9. Backend seams (design for, don't build)

Every mock module mirrors a real PageSpace surface (§2.6): `tasks` → the drive's task lists
(`create_task`/`update_task`/task triggers), `automations` → workflows + calendar triggers,
`commands` → drive commands, `workspaces` → MACHINE pages, `agents` → the cloud-agent control
plane (spawn/logs/send/kill/bench — the one genuinely new service). Fixture data is separated
from UI state so swapping fixtures → SWR is mechanical.
