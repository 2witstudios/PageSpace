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

export const AGENT_LAUNCH_SPECS = {
  'pagespace-cli': { command: 'pagespace-cli', args: [] },
  claude: { command: 'claude', args: [] },
  codex: { command: 'codex', args: [] },
} as const satisfies Record<string, { command: string; args: readonly string[] }>;

export type AgentRuntimeType = keyof typeof AGENT_LAUNCH_SPECS;

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

const MAX_AGENT_TERMINAL_NAME_LENGTH = 100;
const AGENT_TERMINAL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** A user-chosen label for one agent-terminal session within a branch — not a git ref, just an identifier. */
export function isValidAgentTerminalName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_AGENT_TERMINAL_NAME_LENGTH) {
    return false;
  }
  return AGENT_TERMINAL_NAME_RE.test(name);
}
