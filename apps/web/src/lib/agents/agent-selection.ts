/**
 * The Agents surface's URL grammar — the ONE place
 * `?session=<sessionId>&c=<conversationId>&agent=<agentPageId>` is read or
 * written.
 *
 * Successor to `lib/development/development-route.ts`'s single-call-site virtue,
 * with the shape changed: Development put its selection in the PATH
 * (`/development/{machineId}`), which meant every selection was a route change,
 * which meant a remount, which is why that surface needed a keep-alive host to
 * stop terminals dying on every click. Here the selection lives in the QUERY
 * STRING and is written with `history.pushState`, so nothing remounts and the
 * keep-alive machinery has no successor.
 *
 * Param names are `agent` and `c`, matching `lib/url-state.ts` exactly — the
 * right-sidebar assistant already reads `?agent=`/`?c=` from the same location,
 * and one grammar with two spellings would be two grammars.
 *
 * Both directions live here so they cannot drift: the store hydrates through
 * `parseAgentSelection`, every sidebar row and cross-link builds through
 * `buildAgentSelectionUrl`, and `popstate` re-hydrates through the parse again.
 *
 * Vocabulary note: a SESSION is a drive-level workspace hosting many
 * conversations (contract invariant 1). `session` addresses the workspace,
 * `c` the thread inside it, and `agent` names the thread's agent page — the
 * seed the pane grid needs to render the conversation without a second fetch.
 */

/** A selection is total: absent means `null`, never `undefined`, so it compares by value. */
export interface AgentSelection {
  /** The session (workspace) id, or null when nothing is selected. */
  sessionId: string | null;
  /** The conversation inside that session, or null when only the session is selected. */
  conversationId: string | null;
  /** The conversation's agent page — the pane grid's seed. Null for none/global-assistant. */
  agentId: string | null;
}

export const EMPTY_AGENT_SELECTION: AgentSelection = { sessionId: null, conversationId: null, agentId: null };

const SESSION_PARAM = 'session';
const AGENT_PARAM = 'agent';
const CONVERSATION_PARAM = 'c';

/**
 * A present-but-blank param (`?agent=`) is absence, not an id of `""`. Blank
 * values survive hand-edits, stale bookmarks and a build that stringified an
 * empty string, and every one of those means "nothing selected".
 */
function readParam(params: URLSearchParams, key: string): string | null {
  const value = params.get(key);
  return value ? value : null;
}

/**
 * Parse a `window.location.search` (with or without its leading `?`) into a
 * selection. Total by construction — `URLSearchParams` is defined over every
 * string, so no input reaches this function that it can refuse. That matters
 * because the callers are a `popstate` handler and a first render: throwing in
 * either would take the whole surface down over a malformed link.
 */
export function parseAgentSelection(search: string): AgentSelection {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  return {
    sessionId: readParam(params, SESSION_PARAM),
    conversationId: readParam(params, CONVERSATION_PARAM),
    agentId: readParam(params, AGENT_PARAM),
  };
}

/**
 * The surface's path, in either mode. Global (`driveId` absent) is a real view,
 * not a redirect to a resolved drive — it aggregates every accessible drive's
 * agents, exactly as the driveless Development entry aggregated machines.
 */
export function agentsBasePath(driveId: string | null | undefined): string {
  return driveId ? `/dashboard/${encodeURIComponent(driveId)}/agents` : '/dashboard/agents';
}

/**
 * Build the URL for a selection, in whichever mode the caller is in.
 *
 * Absent params are omitted rather than written empty, so the URL a user sees
 * (and copies) carries only what is actually selected — and so that the same
 * selection always stringifies the same way. Param order is fixed (`session`,
 * `c`, `agent`) for the same reason: `pushState` of a byte-identical URL is
 * what makes a re-selection a no-op instead of a duplicate history entry.
 */
export function buildAgentSelectionUrl({
  driveId,
  sessionId,
  agentId,
  conversationId,
}: {
  driveId?: string | null;
  sessionId?: string | null;
  agentId?: string | null;
  conversationId?: string | null;
}): string {
  const params = new URLSearchParams();
  if (sessionId) params.set(SESSION_PARAM, sessionId);
  if (conversationId) params.set(CONVERSATION_PARAM, conversationId);
  if (agentId) params.set(AGENT_PARAM, agentId);
  const query = params.toString();
  const base = agentsBasePath(driveId);
  return query ? `${base}?${query}` : base;
}
