/**
 * Pure derivation of the in-memory `agentTerminalSessionMap` key for a
 * (terminal, scope, name) target.
 *
 * The key is deliberately derived from the OWNING Machine Terminal page id
 * (`terminalId`) rather than the Sprite `sandboxId`. `terminalId` is known the
 * instant a socket connects (it rides in on the handshake), whereas resolving
 * `sandboxId` requires a Sprite/DB round-trip. Keying on `terminalId` lets a
 * warm reattach hit the fast-path map lookup with ZERO I/O — the platform then
 * wakes the paused Sprite lazily on the next exec (docs.sprites.dev/lifecycle,
 * warm wake 100–500ms). Keying on `sandboxId` forced full resolution before the
 * lookup could even run.
 *
 * Machine and project scope share the SAME owning Machine's Sprite, so the
 * scope discriminant (not just terminalId + name) is required to keep e.g. a
 * machine-scope "cli" terminal and a project-scope "cli" terminal on the SAME
 * machine from colliding onto one shared PTY session.
 *
 * This module is pure: explicit params in, string out. No DB, no Sprite SDK, no
 * ambient state. The realtime shell wires it up.
 */

/** The three universal Terminal scopes (`agent-terminals.ts`). */
export type AgentTerminalScope =
  | { kind: 'machine' }
  | { kind: 'project'; projectName: string }
  | { kind: 'branch'; projectName: string; branchName: string };

/**
 * Map the optional (projectName, branchName) pair the transport carries into
 * the discriminated scope. A branch scope needs both names; a lone branch name
 * with no project cannot form one and degrades to a machine scope.
 */
export function agentTerminalScopeFromNames({
  projectName,
  branchName,
}: {
  projectName?: string;
  branchName?: string;
}): AgentTerminalScope {
  if (projectName && branchName) {
    return { kind: 'branch', projectName, branchName };
  }
  if (projectName) {
    return { kind: 'project', projectName };
  }
  return { kind: 'machine' };
}

/**
 * Encode the scope into an unambiguous token. Each variable component is
 * `encodeURIComponent`-escaped so the structural `:` separators can never
 * appear inside a component — a naive `${projectName}:${branchName}` join would
 * collide (project "a"/branch "b:c" vs project "a:b"/branch "c"). The fixed
 * `machine` / `project` / `branch` discriminants keep scopes of different kinds
 * apart even when a project is literally named "machine".
 */
function encodeScope(scope: AgentTerminalScope): string {
  switch (scope.kind) {
    case 'branch':
      return `branch:${encodeURIComponent(scope.projectName)}:${encodeURIComponent(scope.branchName)}`;
    case 'project':
      return `project:${encodeURIComponent(scope.projectName)}`;
    case 'machine':
      return 'machine';
  }
}

/**
 * Derive the stable, collision-free server-side session-map key. Pure and
 * deterministic: the same (terminalId, scope, name) always yields the same key,
 * so a reopened terminal reattaches to its existing session.
 *
 * NOTE: this is the SERVER-side map key only. It is intentionally distinct from
 * the frontend `agent-terminal:*` sessionId wire format
 * (`TerminalPanes.tsx`) — do not conflate the two.
 */
export function deriveAgentTerminalSessionKey({
  terminalId,
  scope,
  name,
}: {
  terminalId: string;
  scope: AgentTerminalScope;
  name: string;
}): string {
  return `${encodeURIComponent(terminalId)}:agent:${encodeScope(scope)}:${encodeURIComponent(name)}`;
}
