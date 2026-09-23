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
 * Line and paragraph separators JSON leaves raw (U+0085, U+2028, U+2029), and
 * the invisible bidi overrides / zero-width marks that can make quoted text
 * render as something else. Escaped so the quoted span stays one visible line.
 */
const UNSAFE_IN_QUOTE = /[\u0085\u2028\u2029\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

function quoteAsData(text: string): string {
  return JSON.stringify(text).replace(UNSAFE_IN_QUOTE, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * A name for another user's model context. A human's name is unchanged, so
 * existing prompts keep their shape. An agent's name is labelled and emitted as
 * a JSON string literal: quoted, with newlines, quotes, Unicode line
 * separators and bidi/zero-width marks escaped, so an injected instruction
 * stays one visible line of quoted data.
 */
export function modelContextUserLabel(account: NamedAccount, fallback = 'Unknown'): string {
  if (!isAgentAccount(account.accountType)) return presentName(account.name) ?? fallback;
  return `${AGENT_MODEL_LABEL} ${quoteAsData(presentName(account.name) ?? AGENT_FALLBACK_NAME)}`;
}
