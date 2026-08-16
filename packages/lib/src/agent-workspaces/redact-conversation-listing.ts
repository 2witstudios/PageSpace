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
 *
 * ADDRESSABILITY IS THE SAME RULE. The worker verbs
 * (`send_session`/`read_session`/`kill_session`) reach a foreign worker only
 * when {@link isConversationVisibleToViewer} says yes — so what an agent may
 * ADDRESS is exactly what it may SEE THE TITLE OF, by construction rather than
 * by two predicates kept in step by hand. Transcript content used to be a
 * separate, stricter gate (owner-only); it is this gate now, which is why the
 * two must not drift. The verbs additionally require drive access to the
 * workspace, so this rule narrows that access — it never widens it.
 */

/** What a foreign private thread's title reads as. Fixed — never derived from the real title. */
export const PRIVATE_THREAD_REDACTION = '(private thread)';

export interface ConversationTitleRedactionInput {
  /** Who is reading the listing. */
  viewerId: string;
  /** The `agent_workspaces` row's owner. Empty/unknown never grants — treat as not-the-viewer. */
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
  if (isConversationVisibleToViewer({ viewerId, workspaceOwnerId, conversation })) {
    return conversation.title;
  }
  return PRIVATE_THREAD_REDACTION;
}

/**
 * The rule itself, as a boolean — whether this viewer may see this conversation
 * AT ALL, which is now the same question as whether they may address it.
 *
 * Extracted so the listing and the worker verbs cannot answer it differently.
 * They used to: the listing redacted a foreign private thread's title while the
 * verbs gated on ownership, and when the verbs widened to drive membership the
 * two rules would have disagreed — an agent shown `(private thread)` for a row
 * it could nonetheless message. One function, one answer.
 *
 * Three ways to qualify, unchanged from the redaction rule this came out of:
 * you own the workspace, you own the thread, or the thread was DELIBERATELY
 * shared (`conversations.isShared`). Fails CLOSED: an empty viewer id matches no
 * owner, so an unidentified viewer sees only explicitly shared threads.
 */
export function isConversationVisibleToViewer({
  viewerId,
  workspaceOwnerId,
  conversation,
}: ConversationTitleRedactionInput): boolean {
  const viewerIsWorkspaceOwner = viewerId.length > 0 && viewerId === workspaceOwnerId;
  const viewerOwnsThread = viewerId.length > 0 && viewerId === conversation.ownerId;
  return viewerIsWorkspaceOwner || viewerOwnsThread || conversation.isShared;
}
