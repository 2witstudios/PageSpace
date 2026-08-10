/**
 * THE WIRE CONTRACT for `GET /api/agent-workspaces/conversations` — ONE
 * declaration of the row shape, imported by both ends.
 *
 * This file exists because both ends used to hand-declare it separately and
 * silently drifted. The `agent_sessions` → `agent_workspaces` rename renamed
 * the server's field to `workspaceId`; the client's two private copies
 * (`PastConversationRow` in `resolveNavigationTarget.ts` and
 * `ConversationRowDTO` in `AgentsPastConversationsList.tsx`) kept saying
 * `sessionId`. Nothing failed to compile, because a hand-written interface
 * handed to `useSWR<T>` / `fetchWithAuth`'s generic is an ASSERTION about
 * data crossing an untyped boundary, not a check of it. So at runtime every
 * row's `sessionId` was `undefined`, every already-bound conversation
 * resolved to `claimable`, its claim 409'd ("already belongs to a session" —
 * because it did), and the click ejected the user to `/dashboard`.
 *
 * Types only, no runtime imports, so a client component can import from it
 * without dragging `@pagespace/db` into the browser bundle.
 *
 * Both ends are now DERIVED from the declarations below — the server row via
 * `PastConversationServerRow`, the client's navigation input via a `Pick` in
 * `resolveNavigationTarget.ts` — and `conversations/__tests__/wire-contract`
 * pins the real route's serialized output against `PastConversationDTO`
 * field-for-field. A rename on either side now fails to COMPILE.
 */

/** `Omit`, but a key that isn't on `T` is a compile error rather than a silent no-op. */
type OmitStrict<T, K extends keyof T> = Omit<T, K>;

/**
 * Mirrors `conversations.type` (`packages/db/src/schema/conversations.ts`) —
 * the only values any production code path writes. `'client'` is the rare
 * API-managed conversation created via `POST /api/v1/conversations` (never
 * `'drive'` — that value was never actually written by any code path; it was
 * a documentation mistake corrected once this got fixed).
 */
export type ConversationKind = 'global' | 'page' | 'client';

/** One past-conversation row, exactly as it arrives in the browser. */
export interface PastConversationDTO {
  conversationId: string;
  title: string | null;
  type: ConversationKind;
  /** The page id when `type === 'page'`, else null. */
  agentPageId: string | null;
  /** The agent page's own title (distinct from the conversation's own title), when `type === 'page'`. */
  pageTitle: string | null;
  /** Real recency — see `recencyExpr` in the runtime. Never simply `conversations.lastMessageAt`, which stays null forever for `type: 'page'`. */
  lastMessageAt: string | null;
  createdAt: string;
  /**
   * THE WORKSPACE (agent session) THIS THREAD BELONGS TO, read from its tree
   * node — null when it belongs to none. Named `workspaceId`, not
   * `sessionId`: the node model calls the root a workspace, and this name is
   * the one the server actually puts on the wire. The client's own
   * vocabulary for the same id is still `sessionId` (the store field, the
   * URL param) — that translation happens once, deliberately, in
   * `resolveNavigationTarget`.
   */
  workspaceId: string | null;
  /** '' when the workspace has no display name, mirroring `toAgentSessionDTO`'s `name ?? ''`. */
  sessionName: string | null;
  sessionEndedAt: string | null;
  /** Resolved from the page's drive, the workspace's drive, or (for `type: 'client'`) the conversation's own contextId. Null only for a driveless global-assistant conversation. */
  driveId: string | null;
}

export interface PastConversationsResponseDTO {
  conversations: PastConversationDTO[];
  pagination: { hasMore: boolean; nextCursor: string | null; limit: number };
}

/**
 * The same rows as the server holds them, one step before `NextResponse.json`
 * serializes them into `PastConversationDTO`.
 *
 * Only two differences, and both are the serializer's doing rather than a
 * second opinion about the shape: timestamps are still real `Date`s, and
 * `type` is still the plain `string` the `conversations.type` text column
 * hands back (the DB, unlike the app, is not constrained to
 * `ConversationKind`). Every other field — crucially every field NAME — comes
 * from the DTO above, so the two cannot drift.
 */
export type PastConversationServerRow = OmitStrict<
  PastConversationDTO,
  'type' | 'lastMessageAt' | 'createdAt' | 'sessionEndedAt'
> & {
  type: string;
  lastMessageAt: Date | null;
  createdAt: Date;
  sessionEndedAt: Date | null;
};
