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
 * What JSON.stringify leaves raw but a reader (human or model) cannot see or
 * mis-reads: C1 controls (incl. U+0085 NEL), the U+2028/2029 separators, the
 * soft hyphen, bidi overrides and marks, zero-width characters, variation
 * selectors, and the invisible Unicode tag block (U+E0000–E007F, a known way to
 * hide instructions from humans while a model still reads them). Escaped so the
 * quoted span stays one visible line of visible data.
 */
const UNSAFE_IN_QUOTE = /[\u0080-\u009F\u00AD\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u2064\u2066-\u2069\uFE00-\uFE0F\uFEFF\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;

function escapeUtf16(ch: string): string {
  let out = '';
  for (let i = 0; i < ch.length; i += 1) out += `\\u${ch.charCodeAt(i).toString(16).padStart(4, '0')}`;
  return out;
}

function quoteAsData(text: string): string {
  return JSON.stringify(text).replace(UNSAFE_IN_QUOTE, escapeUtf16);
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
