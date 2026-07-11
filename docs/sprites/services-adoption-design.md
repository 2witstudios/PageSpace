# Spike: Services adoption design (agent terminals, dev servers)

> **Leaf:** `[sprites 5-3]` — Phase 5, Sprites Platform Alignment epic
> **Type:** Design/research only. No product code changes in this leaf.
> **Status:** Recommendations below are decisions, not options. Follow-up implementation leaves are listed at the end.

---

## 0. TL;DR (the recommendations)

1. **Agent terminals (`claude`/`codex`/`pagespace-cli`) stay exec Sessions, NOT Services.** A Service restarts the agent *fresh* on cold boot (losing the in-progress agent conversation), and only one Service per Sprite can own the HTTP port. Instead we adopt the docs' **composition pattern in reverse of what "become a Service" implies**: the agent process keeps running as a detachable TTY session (as today), and we add a **Tasks-API hold** (leaf 5-1's mechanism) so the runtime keeps the *current* run alive while the agent works, and lets the Sprite pause cleanly when it goes idle. Services are the wrong primitive for "resume the exact conversation I left."
2. **User dev servers DO become Services** — this is the canonical Services use case. We add opt-in service-ification (`sprite service create <name> --http-port <p>`), expose them **private-by-default** via the sprite URL `https://<name>-<org>.sprites.app`, and surface that URL in the Machine/Terminal UI. Start-on-request means a dev server costs nothing while idle and wakes on the first HTTP hit.
3. **`SpriteInstanceLike` gains a minimal `services` sub-surface** (`create`/`list`/`get`/`start`/`stop`/`remove`), mirrored one level up into `MachineHandle`. Pure decision functions (`planDevServerService`, `resolveSpriteServiceUrl`, `classifyDetectedDevServer`) hold all the branching; the SDK wrappers stay thin IO.
4. **Everything is flag-gated behind a new `MACHINE_SERVICES_ENABLED` gate** (composed with the existing `CODE_EXECUTION_ENABLED`), default OFF. Existing machines are unaffected until a service is explicitly created; no migration of running processes.

---

## 1. Grounding — what the platform actually gives us

Quotes are from the Sprites docs, fetched 2026-07-10.

### 1.1 Services lifecycle (`https://docs.sprites.dev/concepts/services/`)

- **Cold boot:** *"Process state was dropped. The runtime starts every service fresh, in dependency order. Wakes take 1–2s."*
- **Warm wake:** *"The VM was suspended with your process inside it. The process resumes mid-thought; it is not restarted. Wakes take 100–500ms."*
- **Crash restart:** *"A service process that exits on its own gets restarted by the runtime."*
- **Stop is sticky:** *"A stopped service stays stopped. The runtime won't restart it behind your back."* And: *"Send TERM or KILL via signal, or kill the PID directly, and the runtime treats it as a crash and restarts the service."*
- **Services don't block pause:** *"A Sprite with ten services defined still pauses when it goes idle; the services come back on the next wake."*
- **HTTP port / start-on-request:** *"Requests to the Sprite's URL route to the service's port instead of 8080."* … *"If the service isn't running when a request arrives, the proxy starts it first, then forwards the request."*
- **One HTTP port per Sprite:** multiple attempts fail with *"409: another service already has an HTTP port configured"*.
- **Dependencies:** *"A service with `--needs` starts after the services it names."* On cold boot *"the runtime starts `postgres` before `app`, every time."*
- **Composition pattern:** *"a service launches the agent at boot, the agent registers a task while it works, the task expires when the work is done, and the Sprite pauses until something needs it again."*

### 1.2 Services vs Tasks (`https://docs.sprites.dev/keeping-sprites-running/`)

- **Service:** *"a long-running process managed by the Sprite runtime: it auto-starts on boot, keeps running through a warm wake (the process is frozen, not terminated), and restarts automatically on a cold wake."* → *"If you only need a process to come back after a pause, use a Service."*
- **Task:** *"Tasks keep the current run alive. They compose: a Service launches the agent, the agent registers a task while it's working."*
- Guidance: **Tasks for** AI agents, queue workers, outbound connections (websockets/MQTT). **Services for** web servers without long-lived state, baseline processes that tolerate cold restarts.

**This is the load-bearing distinction for our design.** The docs explicitly file "AI agents" under Tasks, and "web servers" under Services. Our two workloads map cleanly onto the two primitives.

### 1.3 Networking (`https://docs.sprites.dev/concepts/networking/`)

- Sprite URL: `https://<sprite-name>-<org-id>.sprites.app/`. `sprite info` prints the exact URL.
- **Private by default:** *"reachable only by members of your org, through the browser or with an org token."* Can be made public for webhooks/demos; public means *"anyone with the URL can reach it"* — the docs warn against exposing secrets/internal endpoints.
- `sprite proxy` maps a remote port to localhost for arbitrary TCP (`sprite proxy 3001:3000`), CLI-driven.
- The sprite URL routes HTTPS to the Sprite's HTTP service port only.

### 1.4 Where our code stands today (the gap)

- `SpriteInstanceLike` (`packages/lib/src/services/sandbox/sandbox-client/sprites.ts:141-170`) declares `spawn`, `createSession`, `attachSession`, `listSessions`, `filesystem`, `updateNetworkPolicy`, `destroy` — **no service methods at all**, even though `@fly/sprites@0.0.1-rc37` ships them.
- Agent terminals are exec sessions: `openPtyShell` (`apps/realtime/src/terminal/sprites-shell.ts`) uses `createSession(command, args, {tty:true})` → a TTY session with `max_run_after_disconnect:0` that keeps running after the client WS drops. This is exactly the "lost on any pause" class the docs warn about — a **cold boot drops it entirely** and there is no restart, only client-side reconnect (which finds nothing to reattach to and surfaces an exit).
- `stop` in the sandbox client **DESTROYS** the Sprite (`sdk.deleteSprite`) — no service state to preserve today.
- The `MachineHandle` seam (`packages/lib/src/services/sandbox/machine-host.ts`) is the one coupling point between callers and the backend; it currently exposes `exec`/`writeFiles`/`readFile`/`stream`/`listStreams` and would be the natural home for service methods.

---

## 2. Question 1 — should an agent terminal become a Service or stay a Session + Task hold?

### Recommendation: **stay a Session; add a Tasks-API hold (leaf 5-1). Do NOT make agent terminals Services.**

Three decisive reasons:

**(a) Cold-boot restart is wrong for an agent, right for a web server.** The docs are explicit: on cold boot *"the runtime starts every service fresh."* For `claude`/`codex`/`pagespace-cli`, "fresh" means the agent relaunches with an empty context — the user's in-progress conversation, scrollback, and any half-finished tool call are gone. The whole point of a persistent agent terminal is "come back to *this* session," which is a warm-wake property, not a cold-boot property. A Service gives you cold-boot restart *for free* and warm-wake resume *the same as a session* — so for agents the Service buys nothing on warm wake and actively harms on cold boot. The docs themselves classify "AI agents" under **Tasks**, not Services.

**(b) PTY attach semantics don't fit a service-owned process.** Our terminal model is: the realtime bridge opens/attaches an interactive TTY (`createSession`/`attachSession`) and streams it to xterm. A Service is a runtime-owned process with no TTY the client can attach to for interactive I/O — it's designed for "bind a port," not "give me a keyboard." To drive a service-owned agent interactively we'd have to launch the agent to *also* open an exec session for I/O, which is strictly more moving parts than just… using an exec session. There is no attach-to-service-stdin primitive in the docs.

**(c) The one-HTTP-port-per-Sprite constraint is a hard scarcity.** A machine Sprite hosts many agent terminals (machine + project scopes share one Sprite — see `agent-terminals.ts`). Only one Service per Sprite can own the HTTP port (*"409: another service already has an HTTP port configured"*). If agent terminals were Services, they'd contend for that single slot with the user's actual dev server — which is the workload that genuinely needs the port. Reserve the scarce HTTP-port slot for dev servers.

### What we adopt instead: the composition pattern, minus the "launch as Service" half

The docs' pattern is *"a service launches the agent at boot, the agent registers a task while it works, the task expires when the work is done."* We take the **Task** half and drop the **Service** half:

- The agent terminal launches as today (exec TTY session via the realtime bridge).
- While the agent is actively working, we hold a **Task** (leaf 5-1's `TasksClient`) so the runtime keeps the *current run* alive and does not pause mid-work. This is the fix for "idle terminals reprint their banner" and "detached sprites kept awake 30 min": with a Task hold we keep the Sprite up *precisely while there's work*, and let it pause the instant the work (and the hold) ends — cheaper than a fixed 30-min keep-awake, and correct.
- Cross-reference: the Tasks-hold acquisition/release is **owned by leaf 5-1**, not this leaf. This design only asserts that agent terminals belong on the Session+Task path, and specifies the *boundary*: 5-1 provides `acquireWorkHold(machineId)` / `releaseWorkHold(handle)`; 5-3 does not implement it.

**Pure decision function (this leaf specifies the signature; leaf 5-2/5-4 implements the wiring):**

```ts
// packages/lib/src/services/machines/runtime-primitive.ts  (new, pure)

export type AgentRuntimePrimitive =
  | { kind: 'session-with-task-hold' }   // agents: interactive, resume-exact
  | { kind: 'service'; httpPort?: number }; // dev servers: restart-fresh, bind-port

/**
 * Pure policy: which runtime primitive backs a given agent-terminal type.
 * Agents (claude/codex/pagespace-cli/shell) are always session-with-task-hold.
 * (Dev servers are a SEPARATE surface — see planDevServerService — not an
 * AgentRuntimeType, so this function only ever returns session-with-task-hold
 * today. It exists so the decision is one named, testable place rather than an
 * implicit assumption scattered across the bridge.)
 */
export function selectRuntimePrimitive(agentType: AgentRuntimeType): AgentRuntimePrimitive;
```

---

## 3. Question 2 — user dev servers: detect, expose, surface

### Recommendation: dev servers **become Services**, opt-in, private-by-default, URL surfaced in the Machine UI.

This is the textbook Services use case. A `next dev` / `vite` / `bun dev` process is a web server without long-lived state that tolerates cold restart — exactly what the docs say Services are for — and `--http-port` start-on-request makes it **free while idle**: *"If the service isn't running when a request arrives, the proxy starts it first, then forwards the request."*

#### (a) Detection / offer

Do **not** auto-convert. Auto-service-ifying a process a user ran by hand is surprising and can fight the user's own `Ctrl-C`. Instead:

- **Explicit action (primary path):** a "Publish as service" affordance in the Terminal UI where the user names the command + port. This is unambiguous and needs no heuristics.
- **Detection as a *hint* only (secondary):** the realtime bridge already watches terminal output/activity (`terminal-activity.ts`). A pure classifier scans recent output lines for a listening-port announcement (e.g. `Local: http://localhost:3000`, `listening on :5173`, `Server running at http://0.0.0.0:8080`) and, if found, surfaces a non-blocking "Expose port 3000 as a service?" prompt. The classifier is pure and unit-testable without mocks.

```ts
// packages/lib/src/services/machines/dev-server-detect.ts  (new, pure)

export interface DetectedDevServer {
  /** The port the process announced it is listening on. */
  port: number;
  /** The framework/tool if recognisable (next|vite|bun|node|unknown) — display only. */
  hint: 'next' | 'vite' | 'bun' | 'node' | 'unknown';
}

/**
 * Pure: scan a chunk of terminal output for a dev-server "now listening" banner
 * and extract the port. Returns null when no listening announcement is present.
 * No IO — the bridge feeds it output it already buffers.
 */
export function classifyDetectedDevServer(recentOutput: string): DetectedDevServer | null;
```

#### (b) Exposure — private by default, and auth is **Sprite-URL-scoped, not per-service**

**Critical correction (Codex P1):** In Sprites, URL auth (private vs public) is a property of the **Sprite URL itself**, not of an individual service (docs §1.3: *"A Sprite URL is private by default … reachable only by members of your org"* — the setting is on the URL). Since only one service per Sprite can bind the HTTP port (§1.1), the Sprite URL always points at exactly one HTTP service at a time, so visibility is really a property of **the Sprite's single HTTP-port slot**, not of any service row. Modelling visibility per-service is a security bug: make service A public, then stop/remove/replace it with service B, and the *Sprite URL* stays public while B is stored/rendered as "private" — silently exposing B. So:

- Create the service with `--http-port <p>` so the sprite URL routes to it.
- **Keep the Sprite URL private by default** (org-token / browser-auth). The docs are explicit that public means *"anyone with the URL can reach it"* and warn against exposing internal endpoints. A dev server is an internal, in-progress artifact — default private.
- Track visibility **once per Sprite (the HTTP-port slot), not per service.** Store it on the machine (or a dedicated `sprite_http_exposure` row keyed by `sandboxId`), never on the `machine_services` row.
- Offer an explicit, clearly-labelled "Make Sprite URL public" toggle for the webhook/demo case, gated on the same permission that lets a user run code on the machine. Public exposure is an outward-facing action → it must be a deliberate opt-in, never a default. The UI must present it as *"expose this Sprite's URL"*, not *"expose this service"*, so the blast radius is clear.
- **Reset URL auth to private whenever the public HTTP service is stopped, removed, or replaced by a different service.** Publicness must never outlive the specific service the user consciously exposed — the service lifecycle drives the auth reset. This is the one behavior that closes the P1 hole.
- For arbitrary non-HTTP TCP (a database client, a second port), point power users at `sprite proxy` rather than trying to route it through the sprite URL — the URL only carries the one HTTP service port.

```ts
// packages/lib/src/services/machines/sprite-service-url.ts  (new, pure)

/**
 * Pure: build the canonical sprite service URL from the sprite name + org id.
 * `https://<name>-<org>.sprites.app/`. No IO — name/org come from the caller.
 * Returns null for inputs that can't form a valid DNS label (empty, too long).
 */
export function resolveSpriteServiceUrl(args: { spriteName: string; orgId: string }): string | null;

export type SpriteUrlVisibility = 'private' | 'public';

/**
 * Pure decision: is the requested Sprite-URL visibility change permitted, which
 * service (if any) it is bound to, and what warning copy the UI should show?
 * Scoped to the SPRITE URL / HTTP-port slot — NOT an individual service.
 * Public always warns; private never does. `boundServiceName` records which
 * service the public exposure is tied to, so the caller can auto-reset to
 * private when that service is later stopped/removed/replaced.
 */
export function planSpriteUrlVisibilityChange(args: {
  requested: SpriteUrlVisibility;
  boundServiceName: string | null;   // the HTTP-port service being exposed, if any
  actorCanExposePublicly: boolean;
}): { ok: true; visibility: SpriteUrlVisibility; boundServiceName: string | null; warn: boolean } | { ok: false; reason: 'forbidden' };

/**
 * Pure decision: given the current public-exposure binding and a service that
 * just stopped/was removed/was replaced, must the Sprite URL be reset to
 * private? True iff the departing service is the one the public exposure was
 * bound to. This is what prevents a stale public URL outliving its service.
 */
export function shouldResetSpriteUrlToPrivate(args: {
  currentVisibility: SpriteUrlVisibility;
  boundServiceName: string | null;
  departingServiceName: string;
}): boolean;
```

#### (c) Surface the URL in the PageSpace UI

- Persist a lightweight `machine_services` tracking row (scope-keyed exactly like `machine_agent_terminals`: `machineId` + optional `projectName`/`machineBranchId`, plus `name`, `httpPort`, `stoppedByUser` (see below), `createdBy`). **Visibility is NOT on this row** — it lives once per Sprite (§3b, the P1 fix). This mirrors the existing agent-terminal store pattern and needs a Drizzle migration (`bun run db:generate`, never hand-edited SQL) — **that migration is a follow-up implementation leaf, not this design leaf.**
- The Machine/Navigator panel lists services under the scope with their URL (copy button), a status label (running / will-wake-on-request / **stopped**), and a start/stop/remove control.
- **Distinguish "idle/paused" from "explicitly stopped" (Codex P2).** Start-on-request only fires for a service the runtime considers *live-but-paused*; a **sticky-stopped** service (the user clicked Stop) *stays stopped* and will NOT auto-start on a request until `start` is called (docs §1.1: *"A stopped service stays stopped. The runtime won't restart it behind your back."*). The API's `status: 'stopped'` collapses both, so we track the user's explicit intent ourselves in `stoppedByUser` and derive the label from both:
  - `running` → live.
  - `httpPort` set, API `stopped`, `stoppedByUser === false` → **"will wake on request"** (healthy green — the normal idle steady state).
  - `stoppedByUser === true` → **"stopped"** (neutral/grey, with a Start button) — never shown as wakeable, because a request will 502/idle rather than auto-start it.
  This prevents the UI from promising a wakeable URL for a service the user deliberately turned off.

---

## 4. Question 3 — the composition pattern, concretely, for our agent-terminal types

The docs' pattern: *"a service launches the agent at boot, the agent registers a task while it works, the task expires when the work is done."*

For `AGENT_LAUNCH_SPECS` (`agent-terminal-types.ts`: `pagespace-cli` / `claude` / `codex` / `shell`), the concrete shape is a **two-primitive split**, NOT one Service per agent:

1. **The agent process** = an exec **Session** (unchanged from today). It stays interactive, resumes the exact conversation on warm wake, and is driven by the realtime PTY bridge. `shell` is trivially this too (it's `$SHELL`, no server).
2. **The work hold** = a **Task** acquired by leaf 5-1 whenever the agent is actively producing output / running a tool, released when the terminal goes idle. This is the "agent registers a task while it works" half.

We deliberately **drop** the "a service launches the agent at boot" half for agents, because:

- Our agents are launched *on user demand* (open a terminal), not *at boot*. There's no "relaunch every agent terminal automatically on cold boot" requirement — a user reopening a page re-attaches; if the session is gone (cold boot), the correct UX is "start fresh when the user asks," not "silently relaunch `claude` in the background with no one watching."
- Relaunching agents at boot would burn tokens/compute for terminals no one is looking at.

**Where a Service DOES appear in an agent workflow:** when the agent (or user) *inside* the terminal starts a long-running server — e.g. the agent runs `bun dev` to test its own changes — that server is service-ified via §3. So the composition in practice is: **Session (the agent) + Task (its work hold) + optional Service (a server the agent/user spun up)**, all on the same Sprite. The single HTTP-port slot goes to that server, never to the agent.

Concretely, the launch-spec registry stays the pure data it is; we add a sibling pure module (`runtime-primitive.ts`, §2) that classifies each `AgentRuntimeType` as `session-with-task-hold`. No entry in `AGENT_LAUNCH_SPECS` becomes a Service.

---

## 5. Question 4 — minimal `SpriteInstanceLike` / seam additions

`@fly/sprites@0.0.1-rc37` ships service methods; `SpriteInstanceLike` omits them. The **minimal** additions (only what the chosen design needs — dev-server services, not agent services):

```ts
// packages/lib/src/services/sandbox/sandbox-client/sprites.ts

/** A Sprite service as reported by GET /v1/sprites/{name}/services. */
export interface SpriteServiceInfo {
  name: string;
  command: string;
  /** The service's bound HTTP port, if it claimed one (--http-port). */
  httpPort?: number;
  /** running | stopped — 'stopped' includes both sticky-stop and paused/will-start-on-request. */
  status: 'running' | 'stopped';
  /** Services this one starts after (--needs). */
  needs?: string[];
}

export interface CreateSpriteServiceArgs {
  name: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Claim the Sprite's single HTTP port; 409s if another service already owns it. */
  httpPort?: number;
  /** Start after these named services (dependency ordering). */
  needs?: string[];
}

/** The service sub-surface the driver consumes — added to SpriteInstanceLike. */
export interface SpriteServicesApi {
  create(args: CreateSpriteServiceArgs): Promise<SpriteServiceInfo>;
  list(): Promise<SpriteServiceInfo[]>;
  get(name: string): Promise<SpriteServiceInfo | null>;
  start(name: string): Promise<void>;
  stop(name: string): Promise<void>;   // sticky stop
  remove(name: string): Promise<void>;
}

export interface SpriteInstanceLike {
  // ...existing members unchanged...
  /** Runtime-owned service management (dev servers). Absent on the exec/agent path. */
  services: SpriteServicesApi;
}
```

And one level up, so callers never import `@fly/sprites`, mirror it onto `MachineHandle`:

```ts
// packages/lib/src/services/sandbox/machine-host.ts

export interface MachineServiceInfo {
  name: string;
  command: string;
  httpPort?: number;
  status: 'running' | 'stopped';
}

export interface MachineHandle {
  // ...existing members...
  services(): {
    create(args: CreateSpriteServiceArgs): Promise<MachineServiceInfo>;
    list(): Promise<MachineServiceInfo[]>;
    get(name: string): Promise<MachineServiceInfo | null>;
    start(name: string): Promise<void>;
    stop(name: string): Promise<void>;
    remove(name: string): Promise<void>;
  };
}
```

Notes:
- The `sprite-machine-host.ts` wrapper composes these straight through (it already reaches the raw `sprite` via `sdk.getSprite` for the PTY path — same trick for services).
- The `ExecSandboxClient` seam does **not** change: services are a `MachineHandle`/`SpriteInstanceLike` concern, orthogonal to `getOrCreate`/`get`/`stop`. Note the client's `stop` still `deleteSprite`s (destroys); a Sprite with services is destroyed with them — acceptable, since our services are user dev servers tied to the machine's lifetime, not infra we must preserve.
- `SpriteServiceInfo.status` collapses "paused/will-start-on-request" and "sticky-stopped" into a single `stopped` because the REST surface (`/v1/sprites/{name}/services`) does not distinguish them in the RC SDK. **We therefore do NOT infer wakeability from `status` alone** — a request only auto-starts a paused service, never a sticky-stopped one (docs §1.1). The `stoppedByUser` flag we persist in `machine_services` (§3c) carries the user's explicit-stop intent, and `describeServiceState` takes both:

```ts
// packages/lib/src/services/machines/service-state.ts  (new, pure)

export type ServiceDisplayState =
  | 'running'
  | 'will-wake-on-request'   // httpPort bound, paused, NOT user-stopped → healthy
  | 'stopped';               // user clicked Stop → stays stopped until Start

/**
 * Pure: derive the UI display state. A service is only "will-wake-on-request"
 * when it binds the HTTP port, is currently stopped at the runtime level, AND
 * was NOT explicitly stopped by the user — because start-on-request does not
 * revive a sticky-stopped service (docs §1.1). Without `stoppedByUser` we would
 * wrongly promise a wakeable URL for a service the user deliberately turned off.
 */
export function describeServiceState(args: {
  status: 'running' | 'stopped';
  httpPort?: number;
  stoppedByUser: boolean;
}): ServiceDisplayState;
```

**Pure decision function for creating a dev-server service:**

```ts
// packages/lib/src/services/machines/dev-server-service.ts  (new, pure)

/**
 * Pure guard: is this a valid dev-server service to create on a Sprite?
 * - name must be a valid DNS-ish label (reuse isValidAgentTerminalName rules)
 * - command must be non-empty and within length (reuse isValidAgentTerminalCommand)
 * - httpPort, if present, must be a plausible unprivileged TCP port (1024-65535)
 * Does NOT check the one-port-per-Sprite 409 — that's a runtime error the caller
 * surfaces from list(); this validates the request shape only.
 */
export function planDevServerService(input: {
  name: string;
  command: string;
  httpPort?: number;
}): { ok: true } | { ok: false; reason: 'invalid_name' | 'invalid_command' | 'invalid_port' };

/** Pure: given the existing services on a Sprite, is the HTTP port slot free? */
export function isHttpPortSlotFree(existing: MachineServiceInfo[]): boolean;
```

---

## 6. Question 5 — migration & rollout

### What changes for existing machines: **nothing, until a service is created.**

- Agent terminals keep working exactly as today (Session path). The Task-hold that makes them pause-clean is **leaf 5-1's** change, gated separately.
- No running process is migrated or restarted. Adding the `services` surface to `SpriteInstanceLike`/`MachineHandle` is additive and behind a flag at the call sites.
- `machine_services` is a new table (additive migration via `bun run db:generate`); existing rows/tables untouched.

### Flag gating

- New gate **`MACHINE_SERVICES_ENABLED`** (default OFF), composed with the existing `CODE_EXECUTION_ENABLED` — services only make sense where code execution is already on. Follows the established pattern (Terminal/Sprites work already ships behind `CODE_EXECUTION_ENABLED`, OFF in prod).
- With the flag OFF: `SpriteInstanceLike.services` still exists on the type (harmless), but no UI affordance or route calls it, and the detection hint (§3a) is suppressed.
- Public-exposure toggle is a *second*, stricter gate — a service can exist (private) under `MACHINE_SERVICES_ENABLED` while public exposure stays disabled until we're confident in the auth story. Do not couple them.

### Rollout order

1. Land the pure modules + `SpriteInstanceLike`/`MachineHandle` service surface + fake-driven unit tests (no behavior change; nothing calls it yet).
2. Land the `machine_services` store + migration.
3. Land the realtime detection hint + the "Publish as service" action + private URL surfacing, behind `MACHINE_SERVICES_ENABLED`.
4. (Separately, leaf 5-1) land the agent-terminal Task hold.
5. Public-exposure toggle last, behind its own gate, once auth is validated.

---

## 7. Open questions / risks (flagged, not silently resolved)

- **RC SDK service surface is unverified against a live Sprite.** `@fly/sprites@0.0.1-rc37` is a release candidate; the docs describe `/v1/sprites/{name}/services` but the SDK method names/shapes above are inferred. The first implementation leaf MUST verify the actual SDK surface against a live Sprite (there was no token available in this spike) and adjust `SpriteServicesApi` to match — the *design* (Session+Task for agents, Service for dev servers) is independent of the exact method names.
- **One-HTTP-port-per-Sprite + multi-project machines.** A machine Sprite can host several projects (each a `cwd`), but only one can bind the HTTP port. If two projects each want a dev server on the URL, the second must use `sprite proxy` or a branch Sprite (which is its own Sprite, its own port). The UI must make the single-slot constraint legible rather than 409-ing opaquely — `isHttpPortSlotFree` exists for exactly this pre-check.
- **Cold-boot restart of a dev server may re-run install/build.** A `next dev` that cold-boots restarts fresh; if the framework needs a warm cache the first post-cold-boot request is slow. Acceptable (it's a dev server), but the "will wake on request" UI copy should set the expectation.

---

## 8. Proposed follow-up implementation leaves (Phase 5 sub-tasks)

Each is scoped to one session, TDD + pure-function-first, same protocol as this epic.

| # | Title | One-line scope |
|---|-------|----------------|
| 5-3a | `[sprites 5-3a]` Sprite services SDK surface | Add `SpriteServicesApi`/`SpriteServiceInfo` to `SpriteInstanceLike` + mirror onto `MachineHandle`/`sprite-machine-host`; verify against live SDK; fake-driven unit tests. No caller yet. |
| 5-3b | `[sprites 5-3b]` Dev-server pure decision core | Implement + unit-test `planDevServerService`, `isHttpPortSlotFree`, `classifyDetectedDevServer`, `resolveSpriteServiceUrl`, `planSpriteUrlVisibilityChange`, `shouldResetSpriteUrlToPrivate`, `describeServiceState` (all pure, no mocks). |
| 5-3c | `[sprites 5-3c]` `machine_services` store + migration | New scope-keyed table (mirrors `machine_agent_terminals`), with `stoppedByUser`; Drizzle migration via `db:generate`, store CRUD + tests. Visibility is NOT stored here (see 5-3f). |
| 5-3d | `[sprites 5-3d]` Realtime dev-server detection + "Publish as service" | Wire `classifyDetectedDevServer` into `terminal-activity.ts`; non-blocking "expose port?" prompt; explicit publish action creates the service via `MachineHandle.services()`. Behind `MACHINE_SERVICES_ENABLED`. |
| 5-3e | `[sprites 5-3e]` Service URL surfacing in Machine/Navigator UI | List services under scope with private URL (copy), `describeServiceState`-driven label (running / will-wake-on-request / stopped), start/stop/remove control. |
| 5-3f | `[sprites 5-3f]` Sprite-URL public-exposure toggle | **Sprite-URL-scoped** (not per-service) private→public toggle behind its own stricter gate, stored per-Sprite (`sprite_http_exposure` keyed by `sandboxId`), with the docs' warning copy; auto-reset to private via `shouldResetSpriteUrlToPrivate` when the bound service stops/is removed/is replaced; permission-checked. |
| 5-3g | `[sprites 5-3g]` `selectRuntimePrimitive` + agent Session/Task boundary | Pure `runtime-primitive.ts` classifying every `AgentRuntimeType` as `session-with-task-hold`; document the boundary contract with leaf 5-1's `acquireWorkHold`/`releaseWorkHold`. (Consumes 5-1; do not duplicate the hold impl.) |

> `MACHINE_SERVICES_ENABLED` gate wiring lands with 5-3d (its first real consumer). 5-3a–c are inert plumbing that can land ungated.

---

## 9. Cross-references

- Leaf 5-1 (agent-terminal Tasks-API hold) — owns `acquireWorkHold`/`releaseWorkHold`; 5-3 depends on it for the agent path but does not implement it.
- `packages/lib/src/services/sandbox/sandbox-client/sprites.ts:141-170` — `SpriteInstanceLike` (target of §5).
- `packages/lib/src/services/sandbox/machine-host.ts` — `MachineHandle` seam (mirror target).
- `packages/lib/src/services/machines/agent-terminal-types.ts` — `AGENT_LAUNCH_SPECS` (input to §4).
- `apps/realtime/src/terminal/sprites-shell.ts` — the exec-Session PTY path agents stay on.
- `apps/realtime/src/terminal/terminal-activity.ts` — where detection (§3a) hooks in.
