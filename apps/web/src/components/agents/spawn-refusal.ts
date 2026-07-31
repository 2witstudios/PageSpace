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
