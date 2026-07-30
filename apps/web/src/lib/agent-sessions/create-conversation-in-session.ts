/**
 * Create a conversation BORN INTO a session — the one write path for the
 * thread→session binding (contract invariant 1: set at creation, permanent;
 * moving a thread is a fork, never a rebind).
 *
 * The binding travels INSIDE each creator's INSERT, so no UPDATE of
 * `conversations.sessionId` exists anywhere: rebinding is not refused by a
 * check, it is unrepresentable. That is the fix for the review's H1 — the
 * previous shape (create, then unconditionally UPDATE the binding) let any
 * caller re-point an EXISTING conversation, including someone else's, at
 * their own session, because the page creator reports "exists" by silently
 * succeeding.
 *
 * What each outcome means here:
 * - creator inserted the row → bound, done.
 * - row already existed → allowed ONLY as an idempotent retry: same owner,
 *   same session, same anchor (a pane re-POSTing after a timeout must not
 *   error). Anything else — someone else's row, an unbound row, a different
 *   session's row — is `conversation_unavailable`.
 *
 * Pure decision logic over injected creators, per the repo rule that
 * branching which decides lifecycle/addressing lives in a testable module —
 * `agent-sessions-runtime.ts` only wires the production deps.
 */

export class ConversationUnavailableError extends Error {
  constructor() {
    super('conversation_unavailable');
    this.name = 'ConversationUnavailableError';
  }
}

/**
 * The agent page belongs to a different drive than the session. A session is
 * a DRIVE-level workspace: its sandbox tenant, payer and access decision all
 * derive from ITS drive, so hosting another drive's agent would execute that
 * agent's turns — and bill their runtime — inside a workspace its drive never
 * admitted (three reviewers converged on this: codex p58/p59 + review M6).
 * The global assistant is exempt (no drive); a GLOBAL session (driveId null)
 * therefore hosts ONLY assistant threads.
 */
export class AgentNotInSessionDriveError extends Error {
  constructor() {
    super('That agent belongs to a different drive than this session.');
    this.name = 'AgentNotInSessionDriveError';
  }
}

export interface CreateConversationInSessionDeps {
  /**
   * The page-conversation creator (squat-guarded): inserts with the binding,
   * answers what happened. `conversationRepository.createConversation`.
   */
  createPageConversation: (input: {
    conversationId: string;
    userId: string;
    agentPageId: string;
    sessionId: string;
    title: string | null;
  }) => Promise<'created' | 'exists' | 'message_owner_conflict'>;
  /**
   * The global-conversation creator: inserts with the binding, throws on a
   * foreign owner or a binding mismatch. `resolveOrCreateConversation` —
   * thrown errors are treated as unavailability, whatever their class.
   */
  createGlobalConversation: (input: {
    conversationId: string;
    userId: string;
    sessionId: string;
    title: string | null;
  }) => Promise<void>;
  /** Row facts for the idempotent-retry check. `conversationRepository.getConversation`. */
  findConversation: (conversationId: string) => Promise<{
    userId: string;
    type: string;
    contextId: string | null;
    sessionId: string | null;
  } | null>;
  /** The agent page's drive, or null when the page is missing/trashed/not an agent. */
  findAgentDriveId: (agentPageId: string) => Promise<string | null>;
  /** The session's drive (null = a global-assistant session), or null when the session is missing. */
  findSessionDriveId: (sessionId: string) => Promise<{ driveId: string | null } | null>;
}

export async function createConversationInSessionWith(
  deps: CreateConversationInSessionDeps,
  {
    conversationId,
    userId,
    agentPageId,
    sessionId,
    title = null,
  }: {
    conversationId: string;
    userId: string;
    /** null = a global-assistant conversation. */
    agentPageId: string | null;
    sessionId: string;
    /** Display label written at birth (a spawned worker's name). Labels only — never an address. */
    title?: string | null;
  },
): Promise<void> {
  if (agentPageId === null) {
    try {
      await deps.createGlobalConversation({ conversationId, userId, sessionId, title });
      return;
    } catch {
      // Foreign owner, wrong type, or binding mismatch — one answer, because
      // distinguishing them would tell an id-guessing caller which it was.
      throw new ConversationUnavailableError();
    }
  }

  // THE cross-drive gate, at the ONE binding path so no call site can forget
  // it: the agent must belong to the session's drive. Checked before any row
  // is written, and fail-closed on unresolved facts.
  const [agentDriveId, sessionRow] = await Promise.all([
    deps.findAgentDriveId(agentPageId),
    deps.findSessionDriveId(sessionId),
  ]);
  if (agentDriveId === null || sessionRow === null) throw new ConversationUnavailableError();
  if (sessionRow.driveId !== agentDriveId) throw new AgentNotInSessionDriveError();

  const outcome = await deps.createPageConversation({ conversationId, userId, agentPageId, sessionId, title });
  if (outcome === 'created') return;

  // Not inserted, so not bound. The ONE acceptable shape is our own earlier
  // success being retried: same owner, same binding, same anchor.
  const row = outcome === 'exists' ? await deps.findConversation(conversationId) : null;
  const isIdempotentRetry =
    row !== null &&
    row.userId === userId &&
    row.sessionId === sessionId &&
    row.type === 'page' &&
    row.contextId === agentPageId;
  if (!isIdempotentRetry) throw new ConversationUnavailableError();
}
