/**
 * Pure derivation of the in-memory shell-session-map key for one shell.
 *
 * The successor to `agent-terminal-session-key.ts`, and what it LOST is the
 * point: the `{machineId, scope, name}` tuple (and the whole
 * machine|project|branch scope union) has no successor, because a shell has
 * exactly ONE address — its own `shellId` (`agent_workspace_shells.id`). The
 * bridge resolves shell row → session → sandbox from that id alone.
 *
 * The key is still derived from the WIRE ADDRESS rather than the Sprite
 * `sandboxId`, for the same reason its predecessor keyed on `machineId`: the
 * shellId is known the instant a socket connects, whereas resolving the
 * session's sandbox costs a DB + Sprite round-trip. Keying on the shellId lets
 * a warm reattach hit the fast-path map lookup with ZERO I/O.
 *
 * The `shell:` prefix (with the id URI-escaped) keeps this namespace disjoint
 * from the legacy `<machineId>:agent:<scope>:<name>` keys that share the same
 * process-wide map until the Phase 8 sweep deletes them: a legacy key always
 * contains a bare `:agent:` separator, which an escaped shellId never can.
 *
 * This module is pure: explicit params in, string out. No DB, no Sprite SDK,
 * no ambient state. The realtime shell wires it up.
 */

/**
 * Derive the stable, collision-free server-side session-map key. Pure and
 * deterministic: the same shellId always yields the same key, so a reopened
 * shell reattaches to its existing PTY session.
 */
export function deriveShellSessionKey({ shellId }: { shellId: string }): string {
  return `shell:${encodeURIComponent(shellId)}`;
}
