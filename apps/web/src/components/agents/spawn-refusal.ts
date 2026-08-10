/**
 * Classifies why a session spawn was refused, so the caller can treat the two
 * cases differently:
 *
 * - **quota** (429): the caller HAS the capability and simply ran out of
 *   allowance — worth interrupting them for, since it's actionable ("end a
 *   session").
 * - **capability** (everything else — 403 membership/role, 5xx, network): the
 *   by-design silent degrade. A session owns a sandbox, and a user (or a
 *   moment — e.g. a role that hasn't loaded yet) without that surface must
 *   still be able to chat, without a refusal toast on every visit.
 *
 * Pure and side-effect free so the split is unit-testable without mocking
 * fetch or toast.
 */

export type SpawnRefusalKind = 'quota' | 'capability';

export interface SpawnRefusal {
  kind: SpawnRefusalKind;
  message: string;
}

const DEFAULT_QUOTA_MESSAGE =
  "Your plan's limit for running sandboxes is already in use — stop one before starting another.";
const DEFAULT_CAPABILITY_MESSAGE = 'Workspace unavailable — continuing with a plain chat.';

export function classifySpawnRefusal(status: number | undefined, message: string | null | undefined): SpawnRefusal {
  const trimmed = message?.trim();
  if (status === 429) {
    return { kind: 'quota', message: trimmed && trimmed.length > 0 ? trimmed : DEFAULT_QUOTA_MESSAGE };
  }
  return { kind: 'capability', message: trimmed && trimmed.length > 0 ? trimmed : DEFAULT_CAPABILITY_MESSAGE };
}

/**
 * The workspace a claim's 409 names as the conversation's CURRENT owner, if
 * it named one — the id `POST /api/agent-workspaces` puts in the body of its
 * "that conversation already belongs to a session" refusal.
 *
 * Not every 409 on that route carries one (a `type: 'client'` conversation is
 * refused 409 too, and owns no workspace by construction), hence the null
 * return rather than a throw: absent means "no workspace to open, fall back
 * as before".
 *
 * Disclosure is safe by the time the server writes this id: the route
 * already refused any conversation the caller does not own with a uniform
 * 404, so the only workspace id it can ever name is one holding the caller's
 * own conversation.
 *
 * Deliberately defensive about the body's shape — it comes off the wire, so
 * it is `unknown` until proven otherwise, the exact lesson of the field
 * mismatch this whole change fixes.
 */
export function claimConflictWorkspaceId(status: number | undefined, body: unknown): string | null {
  if (status !== 409) return null;
  if (typeof body !== 'object' || body === null) return null;
  const workspaceId = (body as { workspaceId?: unknown }).workspaceId;
  return typeof workspaceId === 'string' && workspaceId.length > 0 ? workspaceId : null;
}
