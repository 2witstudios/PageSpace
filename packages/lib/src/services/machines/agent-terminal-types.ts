/**
 * Agent-terminal launch specs (pure) — Terminal Epic 2, Runtime tier.
 *
 * "An agent spawns multiple terminals = multiple sessions, pluggable agent
 * type" (tasks/terminal.md). A launch spec is just `{ command, args }` — the
 * binary + args PurePoint's own agent-type model (`~/production/purepoint`
 * `AgentConfig`) uses to launch a session — kept here as pure data (no IO) so
 * both the spawn orchestration (`agent-terminals.ts`) and the realtime PTY
 * bridge (`apps/realtime/src/terminal/`) can resolve the same spec without
 * either owning the registry. Adding a new agent type is one new entry here;
 * nothing that resolves a spec by type branches on which one it got.
 */

/**
 * `shell`'s `command` is the literal string `'shell'` — a SENTINEL, not a real
 * binary — mirroring PurePoint's `default_agents()` (`crates/pu-core/src/
 * types/config.rs`), which maps its `terminal` agent to the command `"shell"`
 * and resolves it to `$SHELL` at spawn time (`parse_agent_command`,
 * `crates/pu-engine/src/engine/helpers.rs`). A bare machine shell is just a
 * machine-scope agent terminal of this type — not a separate concept.
 * Resolving the sentinel to an actual shell binary is an IO concern (reading
 * `process.env.SHELL`) that belongs to whichever layer actually spawns the
 * PTY (the realtime bridge), not this pure module.
 *
 * `pickable` gates the empty-pane "spawn an agent" picker (`TerminalPanes.tsx`
 * — see `PICKABLE_AGENT_TYPES` below). `shell` is PRIMARY here — a plain
 * interactive shell is the default, first-class way to work on a Machine —
 * with `claude`/`codex`/`pagespace` as secondary, opt-in AI agents. Only the
 * retired `pagespace-cli` is excluded. Keeping the marker on the registry
 * entry itself (rather than a hardcoded list living in the UI file) is what
 * keeps the picker in sync when a new entry is added here: forgetting to set
 * `pickable: true` fails safe (excluded, not silently spawnable).
 *
 * `surface` is the rendering discriminator every pane-hosting layer branches
 * on: `'pty'` types spawn a real PTY process (`command`/`args` are launched
 * for real); `'chat'` types render the PageSpace AI chat UI in the pane
 * instead — `pagespace`'s `command` is a dead sentinel, never launched. See
 * `agentSurfaceOf`/`isPtyAgentType` below for the pure accessors callers
 * should use rather than reading `.surface` off the registry directly.
 */
export const AGENT_LAUNCH_SPECS = {
  shell: { command: 'shell', args: [], pickable: true, surface: 'pty' },
  claude: { command: 'claude', args: [], pickable: true, surface: 'pty' },
  codex: { command: 'codex', args: [], pickable: true, surface: 'pty' },
  pagespace: { command: 'pagespace', args: [], pickable: true, surface: 'chat' },
} as const satisfies Record<
  string,
  { command: string; args: readonly string[]; pickable: boolean; surface: 'pty' | 'chat' }
>;

export type AgentRuntimeType = keyof typeof AGENT_LAUNCH_SPECS;

/** The subset of `AgentRuntimeType`s a user can pick from the empty-pane "spawn an agent" picker — see the `pickable` doc comment above. */
export const PICKABLE_AGENT_TYPES: readonly AgentRuntimeType[] = (Object.keys(AGENT_LAUNCH_SPECS) as AgentRuntimeType[]).filter(
  (type) => AGENT_LAUNCH_SPECS[type].pickable,
);

export interface AgentLaunchSpec {
  command: string;
  args: string[];
}

export function isAgentRuntimeType(value: string): value is AgentRuntimeType {
  return Object.prototype.hasOwnProperty.call(AGENT_LAUNCH_SPECS, value);
}

/** Resolve the launch spec for a known agent type. Throws on an unknown type — callers must validate with `isAgentRuntimeType` first. */
export function resolveAgentLaunchSpec(type: AgentRuntimeType): AgentLaunchSpec {
  const spec = AGENT_LAUNCH_SPECS[type];
  return { command: spec.command, args: [...spec.args] };
}

export type AgentSurface = 'pty' | 'chat';

/** The pane surface a given agent type renders: a real PTY process, or the PageSpace AI chat UI. */
export function agentSurfaceOf(type: AgentRuntimeType): AgentSurface {
  return AGENT_LAUNCH_SPECS[type].surface;
}

/** Whether an agent type spawns a real PTY process (as opposed to a `'chat'`-surface type like `pagespace`). */
export function isPtyAgentType(type: AgentRuntimeType): boolean {
  return agentSurfaceOf(type) === 'pty';
}

const MAX_AGENT_TERMINAL_NAME_LENGTH = 100;
const AGENT_TERMINAL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** A user-chosen label for one agent-terminal session within a branch — not a git ref, just an identifier. */
export function isValidAgentTerminalName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_AGENT_TERMINAL_NAME_LENGTH) {
    return false;
  }
  return AGENT_TERMINAL_NAME_RE.test(name);
}

const MAX_AGENT_TERMINAL_COMMAND_LENGTH = 500;

/**
 * An optional per-terminal program override — an agent terminal can run an
 * arbitrary command in its PTY instead of just the `agentType`'s default
 * binary (mirrors PurePoint's `AgentEntry.command` / `SpawnParams.
 * terminal_command`, `crates/pu-core/src/types/agent.rs`). Only rejects
 * obviously-invalid input (empty, absurdly long) — interpreting the command
 * string (splitting args, deciding whether to wrap it in `$SHELL -c` for
 * metacharacters) is the launching layer's job, not this validator's.
 */
export function isValidAgentTerminalCommand(command: string): boolean {
  return typeof command === 'string' && command.trim().length > 0 && command.length <= MAX_AGENT_TERMINAL_COMMAND_LENGTH;
}
