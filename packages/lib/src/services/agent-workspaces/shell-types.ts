/**
 * Shell launch specs (pure) — the gutted successor to
 * `services/machines/agent-terminal-types.ts`.
 *
 * A launch spec is just `{ command, args }`: the binary + args a PTY is opened
 * with. It stays pure data (no IO) so both the spawn orchestration
 * (`session-shells.ts`) and the realtime PTY bridge resolve the SAME spec
 * without either owning the registry. Adding a PTY agent CLI is one new entry
 * here; nothing that resolves a spec branches on which one it got.
 *
 * PTY-ONLY BY CONSTRUCTION — the one structural change versus the predecessor.
 * There, `AGENT_LAUNCH_SPECS` carried a `surface` discriminator because the
 * `'pagespace'` entry rendered a chat UI instead of launching anything, and
 * every resolve/kill path had to ask `isPtyAgentType` first to avoid waking a
 * Sprite for a row that could never open a PTY. That entry has no successor: a
 * session's chat surface IS its conversation. So `surface`, `agentSurfaceOf`
 * and `isPtyAgentType` are all deleted, and with them every caller-side branch
 * they existed to feed — every shell is a PTY.
 *
 * The type list itself lives in `contract.ts` (`SHELL_AGENT_TYPES`), which is
 * what crosses the wire; this module only adds the launch DATA for each one.
 * The `satisfies Record<ShellAgentType, …>` below is what keeps the two from
 * drifting: adding a type to the contract without a spec here fails to compile.
 */

import type { ShellAgentType } from '../../agent-workspaces/contract';

export interface ShellLaunchSpecEntry {
  command: string;
  args: readonly string[];
  /**
   * Gates the "new shell" pickers. Keeping the marker on the registry entry
   * (rather than a hardcoded list in a UI file) is what keeps the pickers in
   * sync when an entry is added: forgetting it fails safe (excluded, not
   * silently spawnable), and this object's key ORDER is the display order.
   */
  pickable: boolean;
}

/**
 * `shell`'s `command` is the literal string `'shell'` — a SENTINEL, not a real
 * binary — mirroring PurePoint's `default_agents()`, which maps its terminal
 * agent to the command `"shell"` and resolves it to `$SHELL` at spawn time.
 * Resolving the sentinel to an actual binary is an IO concern (reading
 * `process.env.SHELL`) belonging to whichever layer spawns the PTY (the
 * realtime bridge), not this pure module.
 */
export const AGENT_LAUNCH_SPECS = {
  shell: { command: 'shell', args: [], pickable: true },
} as const satisfies Record<ShellAgentType, ShellLaunchSpecEntry>;

/** The subset a user can pick when opening a shell — see the `pickable` doc above. */
export const PICKABLE_SHELL_AGENT_TYPES: readonly ShellAgentType[] = (
  Object.keys(AGENT_LAUNCH_SPECS) as ShellAgentType[]
).filter((type) => AGENT_LAUNCH_SPECS[type].pickable);

export interface ShellLaunchSpec {
  command: string;
  args: string[];
}

export function isShellAgentType(value: string): value is ShellAgentType {
  return Object.prototype.hasOwnProperty.call(AGENT_LAUNCH_SPECS, value);
}

/** Resolve the launch spec for a known agent type. Callers must validate with `isShellAgentType` first. */
export function resolveShellLaunchSpec(type: ShellAgentType): ShellLaunchSpec {
  const spec = AGENT_LAUNCH_SPECS[type];
  // A fresh array per call: a caller that mutates what it got back must not be
  // able to edit the registry for everyone else.
  return { command: spec.command, args: [...spec.args] };
}

const MAX_SHELL_COMMAND_LENGTH = 500;

/**
 * An optional per-shell program override — a shell can run an arbitrary command
 * in its PTY instead of the agent type's default binary. Only rejects
 * obviously-invalid input (empty, absurdly long): interpreting the string
 * (splitting args, wrapping metacharacters in `$SHELL -c`) is the launching
 * layer's job, not this validator's.
 */
export function isValidShellCommand(command: string): boolean {
  return typeof command === 'string' && command.trim().length > 0 && command.length <= MAX_SHELL_COMMAND_LENGTH;
}
