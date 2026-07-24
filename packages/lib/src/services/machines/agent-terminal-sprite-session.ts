/**
 * Per-session Sprite identity for an agent terminal (pure).
 *
 * Every spawned agent-terminal session (`machine_agent_terminals` row) is its
 * OWN Sprite — never the owning Machine's, and never shared with any other
 * session at the same location. `deriveAgentTerminalSessionSpriteKey` mirrors
 * `deriveBranchSessionKey` (branch-session.ts) / `deriveMachineSessionKey`: an
 * opaque HMAC name, namespaced so a (tenant, machine, terminal ROW id) tuple
 * ALWAYS resolves to the same Sprite name — and, critically, two different
 * terminal ids always resolve to two DIFFERENT Sprite names, so
 * `MachineHost.provision` (which auto-resumes "same name, same filesystem")
 * can never accidentally hand two sessions the same underlying Sprite.
 *
 * The terminal ROW id is the identity fold, NOT (scope, name): a row's id is
 * globally unique and stable for its lifetime, so a re-provision of a vanished
 * session Sprite lands on the same name, while two distinct rows — even at the
 * same scope with the same name across a delete/recreate — never collide.
 *
 * DISTINCT from the in-memory PTY key `deriveAgentTerminalSessionKey`
 * (apps/realtime/src/terminal/agent-terminal-session-key.ts), which names a PTY
 * stream session, not a Sprite VM. This one is the Sprite VM name.
 */

import { createHmac } from 'crypto';

export interface AgentTerminalSessionSpriteKeyInput {
  tenantId: string;
  machineId: string;
  /** The `machine_agent_terminals` row's OWN id — the per-session identity fold. */
  terminalId: string;
  secret: string;
}

const NAMESPACE_VERSION = 'agent-terminal-sprite:v1';

export function deriveAgentTerminalSessionSpriteKey({
  tenantId,
  machineId,
  terminalId,
  secret,
}: AgentTerminalSessionSpriteKeyInput): string {
  if (secret.length === 0) {
    throw new Error('deriveAgentTerminalSessionSpriteKey requires a non-empty secret');
  }
  const payload = [NAMESPACE_VERSION, tenantId, machineId, terminalId].join('\0');
  // codeql[js/insufficient-password-hash] not a password hash — a keyed HMAC over SANDBOX_SESSION_SECRET (a >=32-char server secret, never user input) deriving a deterministic Sprite-name pseudonym, same as machine-session-manager.ts's deriveMachineSessionKey
  const digest = createHmac('sha3-256', secret).update(payload).digest('hex');
  return `pgs-agt-${digest}`;
}
