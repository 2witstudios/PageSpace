/**
 * The scope an agent may hold from the jwt-bearer grant (ADR 0007 Decision 6,
 * threat model T4). Pure.
 *
 * The exchange mints a `ps_at_`/`ps_rt_` pair for the agent's own account and
 * nothing else: `account` (+ `offline_access` for a refresh token). Content
 * scopes (`drive:*`, `all_drives`) and key-shaped scopes (`manage_keys`,
 * `update_key:*`, `activate_key:*`, `name:*`) are refused — an agent that
 * wants content access mints an `mcp_` key through the normal key-management
 * API once signed in. ADR 0002's grammar is untouched: this only narrows what
 * the grammar admits on one grant.
 */
import { parseScopeList, formatScopeSet } from '@pagespace/lib/auth/oauth/scopes';

export const AGENT_ASSERTION_DEFAULT_SCOPE = 'account offline_access';

const AGENT_ASSERTION_ALLOWED_SCOPES: ReadonlySet<string> = new Set(['account', 'offline_access']);

export type AgentAssertionScopeResult = { ok: true; scopes: string[] } | { ok: false };

export function resolveAgentAssertionScopes(raw: string | null): AgentAssertionScopeResult {
  const requested = raw === null || raw.trim() === '' ? AGENT_ASSERTION_DEFAULT_SCOPE : raw;
  const parsed = parseScopeList(requested);
  if (!parsed.ok) return { ok: false };

  // A positive allowlist over what the grammar parsed, not a list of refused
  // shapes: a scope kind added to ADR 0002 later is refused here by default.
  // `account` is always present on success — the grammar rejects
  // `offline_access` alone, and nothing else is on the list.
  const granted = formatScopeSet(parsed.scopes).split(' ').filter(Boolean);
  if (granted.some((scope) => !AGENT_ASSERTION_ALLOWED_SCOPES.has(scope))) return { ok: false };

  return { ok: true, scopes: granted };
}
