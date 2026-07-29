/**
 * Storage attribution key — the ONE place that answers "whose bill does an
 * agent-session Sprite's persistent filesystem land on?".
 *
 * Narrowed by the Phase 8 teardown: this used to arbitrate FIVE subject kinds
 * — a Machine's own Sprite, a branch-terminal's, a promoted project's, a
 * per-session agent-terminal's, and an `agent_sessions` row's — one per tier
 * of the deleted Machine page type's tree, all unconditionally attributed to
 * an owning Machine page. Only the `agent_sessions` kind survives (the other
 * four's tables are dropped), and it breaks that "attribution is always a
 * page" assumption: `agentPageId` is nullable (a global-assistant session has
 * no backing page), so `storageBillingTarget` falls through to the session's
 * own `ownerId` — the payer of last resort, and the ONLY payer for a
 * global-assistant session — with no page lookup at all (mirrors
 * `resolveAgentSessionPayerId` in `billing/sandbox-payer.ts`).
 */

/** A billable agent-session Sprite. */
export interface StorageSubject {
  /** The `agent_sessions` row's PK — ≡ sessionId ≡ conversationId. */
  sessionId: string;
  /** The session's backing agent page; null for a global-assistant session. */
  agentPageId: string | null;
  /** The session's own owner — the payer of last resort, and the ONLY payer when `agentPageId` is null. */
  ownerId: string;
}

/**
 * Who ultimately gets billed for a subject's storage, and — separately —
 * what pageId (if any) the usage-breakdown groups it under. A
 * global-assistant session (null `agentPageId`) has no page to attribute to,
 * so billing falls straight through to its `ownerId` with no page lookup at
 * all (mirrors `resolveAgentSessionPayerId` in `billing/sandbox-payer.ts`,
 * which the storage reconcile's IO composition uses for the `ownerId` case).
 */
export function storageBillingTarget(subject: StorageSubject): { pageId: string } | { ownerId: string } {
  return subject.agentPageId ? { pageId: subject.agentPageId } : { ownerId: subject.ownerId };
}
