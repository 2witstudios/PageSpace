/**
 * The ONE shared-workspace listing redaction rule (issue #2262 finding 6).
 *
 * A workspace listing shows every open conversation's title, agent, and
 * activity time to every viewer with session access — deliberate
 * shared-workspace semantics for the workspace's OWN owner, but a member
 * looking into a workspace they do NOT own was also reading the titles of
 * other members' private threads. The conservative rule, decided in
 * PR "list_sessions discovers shared workspaces" and explicitly open to
 * product veto (the mechanism is this one function):
 *
 *  - The workspace's OWNER sees every title in their own workspace, unchanged.
 *  - Any other viewer sees a conversation's title only when the thread is
 *    their own or deliberately shared (`conversations.isShared`); everything
 *    else keeps its ROW (agent id + activity time — the orchestration signal
 *    "something is running here" is the listing's point) but its title reads
 *    as the fixed {@link PRIVATE_THREAD_REDACTION} marker.
 *
 * PURE and single-sourced on purpose: every listing surface that maps
 * session conversations for a viewer (`listWorkspaceWorkers` /
 * `listSharedWorkspaces` in `apps/web/src/lib/ai/tools/session-tools-runtime.ts`)
 * must route titles through this function rather than re-deriving the rule.
 * TRANSCRIPT content is a separate, stricter gate (`openOwnSession` — owner
 * only) that this rule never widens.
 */

/** What a foreign private thread's title reads as. Fixed — never derived from the real title. */
export const PRIVATE_THREAD_REDACTION = '(private thread)';

export interface ConversationTitleRedactionInput {
  /** Who is reading the listing. */
  viewerId: string;
  /** The `agent_sessions` row's owner. Empty/unknown never grants — treat as not-the-viewer. */
  workspaceOwnerId: string;
  conversation: {
    /** The conversation's own owner (`conversations.userId`). */
    ownerId: string;
    /** The thread was deliberately shared (`conversations.isShared`). */
    isShared: boolean;
    title: string | null;
  };
}

/**
 * The title a viewer may see for one conversation in a workspace listing —
 * either the real title or {@link PRIVATE_THREAD_REDACTION}. See module doc
 * for the rule; fails CLOSED (an empty viewer id matches no owner, so it
 * redacts everything that is not explicitly shared).
 */
export function redactConversationTitleForViewer({
  viewerId,
  workspaceOwnerId,
  conversation,
}: ConversationTitleRedactionInput): string | null {
  const viewerIsWorkspaceOwner = viewerId.length > 0 && viewerId === workspaceOwnerId;
  const viewerOwnsThread = viewerId.length > 0 && viewerId === conversation.ownerId;
  if (viewerIsWorkspaceOwner || viewerOwnsThread || conversation.isShared) {
    return conversation.title;
  }
  return PRIVATE_THREAD_REDACTION;
}
