/**
 * Is THIS machine's active key the agent's own key? (Agent Signup Phase 5.)
 *
 * `pagespace mcp` normally refuses the active key: an MCP config must name its
 * credential, so an MCP client never rides a key a HUMAN activated on this
 * machine. When the login stored for the host is an AI agent's own account
 * (`kind: 'agent'`) and the active key is the key that agent minted for itself
 * (`contentKeyName`), there is no human credential to ride — the agent is the
 * only identity here, and its key acts as nobody but the agent. That one case
 * is allowed, so an agent that ran `pagespace signup --agent` can run
 * `pagespace mcp` with zero further steps. Any other active key keeps the
 * refusal.
 *
 * Pure; the caller (`run.ts`) does the two store reads.
 */
import type { HostCredential } from '../credentials/serialize.js';

export function isAgentOwnActiveKey(login: HostCredential | null, activeKeyName: string | null): boolean {
  return (
    login !== null &&
    login.kind === 'agent' &&
    login.contentKeyName !== null &&
    activeKeyName !== null &&
    activeKeyName === login.contentKeyName
  );
}
