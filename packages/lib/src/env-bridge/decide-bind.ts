/**
 * May this actor bind a session to this LOCAL environment? (invariant 11)
 *
 * This is the SERVER-side gate, and it is necessary but never sufficient: the
 * daemon on the user's machine still decides for itself (`decideExecution`).
 * It composes, in a fixed order, the existing code-execution gate — whose
 * RESULT is an input here; its checks are never re-implemented — with the
 * env's own state and its owner-declared `bindPolicy`:
 *
 *   flag_disabled → code_exec_denied → not_local → revoked → not_connected
 *   → bind_policy
 *
 * The cloud opt-in flag comes first so a deployment that has not enabled
 * local envs never evaluates anything else; the base gate comes next so no
 * bind policy can widen what `canRunCode` already refused. `not_local` keeps
 * Sprite envs on their existing path untouched. A revoked or disconnected
 * env refuses before policy is consulted: a bind never queues on a dead
 * machine.
 *
 * `bindPolicy` semantics — the env OWNER (the user who enrolled the machine)
 * always passes, because it is their hardware:
 *   owner   — only the env owner. A drive admin who did not enroll the
 *             machine may not bind (RCE on someone else's hardware).
 *   admins  — the env owner, or a drive admin/owner.
 *   members — anyone who passed `canRunCode`.
 * Any other value is a drifted or hostile row and denies.
 *
 * Pure: no db, no ws, no clock. `revokedAt` is judged by presence only.
 */
import type { CanRunCodeResult, CodeExecutionDenialReason } from '../services/sandbox/can-run-code';

export type BindPolicy = 'owner' | 'admins' | 'members';
export type ActorRole = 'owner' | 'admin' | 'member';

export interface BindEnv {
  readonly ownerId: string;
  readonly substrate: string;
  readonly revokedAt: number | string | Date | null;
}

export interface DecideBindInput {
  readonly canRunCode: CanRunCodeResult;
  readonly bindPolicy: BindPolicy;
  readonly actorRole: ActorRole;
  readonly actorId: string;
  readonly env: BindEnv;
  /** Whether the env's bridge socket is live right now. */
  readonly connected: boolean;
  /** `LOCAL_ENVS_ENABLED` for this deployment. */
  readonly flagEnabled: boolean;
}

export type BindDenyReason = 'flag_disabled' | 'code_exec_denied' | 'not_local' | 'revoked' | 'not_connected' | 'bind_policy';

/** The documented, tested deny order. */
export const BIND_DENY_ORDER: readonly BindDenyReason[] = ['flag_disabled', 'code_exec_denied', 'not_local', 'revoked', 'not_connected', 'bind_policy'];

export type BindVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: BindDenyReason; readonly cause?: CodeExecutionDenialReason };

function policyAllows(policy: BindPolicy, actorRole: ActorRole, actorId: string, ownerId: string): boolean {
  if (actorId === ownerId) return true;
  switch (policy) {
    case 'owner':
      return false;
    case 'admins':
      return actorRole === 'admin' || actorRole === 'owner';
    case 'members':
      return true;
    default:
      return false;
  }
}

/** @returns `ok`, or the first deny reason in `BIND_DENY_ORDER` that applies. */
export function decideBind(input: DecideBindInput): BindVerdict {
  if (!input.flagEnabled) return { ok: false, reason: 'flag_disabled' };
  if (!input.canRunCode.ok) return { ok: false, reason: 'code_exec_denied', cause: input.canRunCode.reason };
  if (input.env.substrate !== 'local') return { ok: false, reason: 'not_local' };
  if (input.env.revokedAt !== null) return { ok: false, reason: 'revoked' };
  if (!input.connected) return { ok: false, reason: 'not_connected' };
  if (!policyAllows(input.bindPolicy, input.actorRole, input.actorId, input.env.ownerId)) return { ok: false, reason: 'bind_policy' };
  return { ok: true };
}
