/**
 * Claim a NEVER-BOUND conversation into a workspace — which, now that
 * membership is the node row, is simply CREATING that node.
 *
 * This module used to be the only place `conversations.workspaceId` was ever
 * written, and its whole design was about making that one UPDATE unable to
 * re-point a binding: `workspaceId IS NULL` and `userId = :caller` rode the
 * WHERE so neither a bound row nor a foreign one could match. That guard was
 * correct and it is gone, because the thing it guarded is gone. The binding now
 * lives in `agent_workspace_nodes`, whose global
 * `UNIQUE (targetId) WHERE targetKind = 'chat'` says the same sentence as a
 * DATABASE CONSTRAINT rather than as a WHERE clause a future writer could
 * forget: a conversation is bound to at most one node anywhere, so a second
 * workspace claiming it is refused by the index, in the transaction, whatever
 * the caller checked first.
 *
 * What survives unchanged is the OWNERSHIP gate and the drive rules. Those were
 * never properties of the column; they are properties of who may put whose
 * thread into which workspace, and no index states them.
 *
 * Pure decision logic over injected deps, per the repo rule that branching
 * which decides lifecycle/access lives in a testable module —
 * `agent-workspaces-runtime.ts` only wires the production deps.
 */

/**
 * How the membership write answered.
 *
 * `bound_elsewhere` is the one the database decides: the pre-check below asks
 * the same question, but between that read and the write another request can
 * win, and only the unique index is in a position to settle it.
 */
export type AdmitConversationOutcome =
  | 'admitted'
  | 'already_a_member'
  | 'session_full'
  | 'bound_elsewhere'
  | 'refused';

export type ClaimConversationOutcome =
  | 'claimed'
  | 'already_in_session'
  | 'not_found'
  | 'cross_drive_denied'
  | 'session_full';

/**
 * The membership deps every path into a workspace shares.
 *
 * `Tx` is the transaction handle the membership write hands to
 * {@link AdmitConversationInput.within}. It is a type PARAMETER rather than a
 * concrete Drizzle type so this module stays free of the database entirely —
 * the wiring supplies both the handle and everything that knows what to do with
 * one.
 */
export interface ClaimConversationInSessionDeps<Tx = unknown> {
  /** Row facts for the ownership/state gates. `conversationRepository.getConversation`, narrowed. */
  findConversation: (conversationId: string) => Promise<{
    userId: string;
    type: string;
    contextId: string | null;
    isActive: boolean;
  } | null>;
  /**
   * The workspace whose tree already holds this thread, or `null`.
   *
   * The successor to reading `conversations.workspaceId`: one lookup on the
   * chat-target index. An ADVISORY read — it decides the answer a caller sees
   * in the ordinary case, and the index decides it in the racing one.
   */
  findWorkspaceOfConversation: (conversationId: string) => Promise<string | null>;
  /** The agent page's drive, or null when the page is missing/trashed/not an agent. */
  findAgentDriveId: (agentPageId: string) => Promise<string | null>;
  /** The target workspace's drive and liveness, or null when the workspace is missing. */
  findSession: (workspaceId: string) => Promise<{ driveId: string | null; endedAt: Date | null } | null>;
  /**
   * THE MEMBERSHIP WRITE — mint the node that makes this thread a member,
   * inside the workspace's own locked transaction.
   *
   * The cap is enforced in there, against the tree, which is why no
   * `countActiveConversations` dep survives: a count read out here would be a
   * number racing the write it was meant to bound.
   */
  admitConversation: (input: AdmitConversationInput<Tx>) => Promise<AdmitConversationOutcome>;
}

export interface AdmitConversationInput<Tx = unknown> {
  conversationId: string;
  workspaceId: string;
  /**
   * Put it on screen now, or leave it parked. Both are membership — see
   * `workspace-membership.ts`'s `AdmitInput.attach`.
   */
  attach: boolean;
  /** The spawning conversation, never evicted by the thing it spawned. */
  excludeTargetId?: string;
  /** Work that must land in the SAME transaction as the node. Only the create path has any. */
  within?: (tx: Tx) => Promise<void>;
}

export async function claimConversationInSessionWith<Tx>(
  deps: ClaimConversationInSessionDeps<Tx>,
  {
    conversationId,
    userId,
    workspaceId,
    attach = false,
  }: { conversationId: string; userId: string; workspaceId: string; attach?: boolean },
): Promise<ClaimConversationOutcome> {
  const row = await deps.findConversation(conversationId);
  if (row === null) return 'not_found';
  // The H1 gate — checked before anything else, so no later branch can answer
  // for a foreign row. It is the one gate the node table cannot state for us:
  // the index knows a thread has one home, not whose thread it is.
  if (row.userId !== userId) return 'not_found';
  if (!row.isActive) return 'not_found';

  // `'client'` rows are API-managed and have no in-app viewer
  // (`resolveNavigationTarget` already calls them `unavailable`); binding one
  // would hand an API-managed thread a sandbox nothing can display.
  if (row.type !== 'page' && row.type !== 'global') return 'not_found';

  const home = await deps.findWorkspaceOfConversation(conversationId);
  // Idempotent retry: a double-click, a retried POST after a timeout, or two
  // panes racing the same claim must not error, and must not consume a second
  // cap slot for a thread already inside the ceiling.
  if (home === workspaceId) return 'already_in_session';
  // Any OTHER workspace — including one the caller owns — is refused. This is
  // the line that keeps H1 fixed, and unlike the old version it is a
  // convenience rather than the enforcement: the unique index refuses the same
  // thing a moment later, whatever raced through here.
  if (home !== null) return 'not_found';

  const sessionRow = await deps.findSession(workspaceId);
  if (sessionRow === null) return 'not_found';
  // An ENDED session is a valid claim target, not a tombstone: the lifecycle
  // treats ended rows as resumable ("a torn-down session re-provisions under
  // the SAME key" — plan-session-lifecycle's ensure intent), and the claim
  // wiring reopens the listing (`planSessionReopen`) when a claim lands in
  // one. Refusing here contradicted that and permanently dead-ended every
  // thread bound to an ended workspace (issue #2335). Session lifecycle
  // state never gates a permitted claim; only ownership and drive rules do.

  if (row.type === 'page') {
    if (row.contextId === null) return 'not_found';
    const agentDriveId = await deps.findAgentDriveId(row.contextId);
    if (agentDriveId === null) return 'not_found';
    // A GLOBAL session (driveId null) is exempt — see
    // `AgentNotInSessionDriveError`'s doc comment in the create module for
    // the full rationale; the same exemption applies here.
    if (sessionRow.driveId !== null && sessionRow.driveId !== agentDriveId) return 'cross_drive_denied';
  }

  const admitted = await deps.admitConversation({ conversationId, workspaceId, attach });
  switch (admitted) {
    case 'admitted':
      return 'claimed';
    case 'already_a_member':
      return 'already_in_session';
    case 'session_full':
      return 'session_full';
    // The world changed between the reads above and the write: another request
    // claimed it first, or the tree refused the shape. Both collapse to the
    // same answer a stale read would have produced — an id-guessing caller
    // learns nothing from the difference.
    case 'bound_elsewhere':
    case 'refused':
      return 'not_found';
  }
}
