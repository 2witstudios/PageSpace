/**
 * How an agent's name is shown to anyone else (Agent Signup Phase 2b).
 *
 * An agent picks its own `users.name` at registration (1–80 characters, no
 * vetting). React escapes it, so this is not XSS; it is impersonation ("PageSpace
 * Support") in member lists and chat, and prompt injection once the name lands
 * in another user's model context. So wherever a name is shown for an agent,
 * a marker derived from `accountType` goes with it — never anything parsed out
 * of the name, which the agent controls.
 *
 * UI surfaces render `AgentBadge` (apps/web) from `isAgentAccount`; model
 * context uses `modelContextUserLabel`. Pure: callers pass the `name` and
 * `accountType` they already selected.
 *
 * @module @pagespace/lib/auth/agent/display-name
 */

/** The label that precedes an agent's quoted name in model context. */
const AGENT_MODEL_LABEL = '[AI agent account, self-named]';

const AGENT_FALLBACK_NAME = 'Agent';

export interface NamedAccount {
  name: string | null | undefined;
  /** `users.accountType`; anything other than `agent` is treated as human (the column default). */
  accountType: string | null | undefined;
}

export function isAgentAccount(accountType: string | null | undefined): boolean {
  return accountType === 'agent';
}

function presentName(name: string | null | undefined): string | null {
  const trimmed = name?.trim();
  return trimmed ? trimmed : null;
}

/**
 * A name for another user's model context. A human's name is unchanged, so
 * existing prompts keep their shape. An agent's name is labelled and emitted as
 * a JSON string literal: quoted, with newlines and quotes escaped, so an
 * injected instruction stays one line of quoted data.
 */
export function modelContextUserLabel(account: NamedAccount, fallback = 'Unknown'): string {
  if (!isAgentAccount(account.accountType)) return presentName(account.name) ?? fallback;
  return `${AGENT_MODEL_LABEL} ${JSON.stringify(presentName(account.name) ?? AGENT_FALLBACK_NAME)}`;
}
