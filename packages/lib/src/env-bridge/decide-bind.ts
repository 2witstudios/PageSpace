/**
 * May this actor bind a session to this LOCAL environment? (invariants 11, 13)
 *
 * This is the SERVER-side gate, and it is necessary but never sufficient: the
 * daemon on the user's machine still decides for itself (`decideExecution`).
 * It composes, in a fixed order, the existing code-execution gate — whose
 * RESULT is an input here; its checks are never re-implemented — with the
 * env's own state, its owner, and its server policy:
 *
 *   flag_disabled → code_exec_denied → not_local → revoked → not_connected
 *   → bind_policy → no_server_ops
 *
 * The cloud opt-in flag comes first so a deployment that has not enabled
 * local envs never evaluates anything else; the base gate comes next so no
 * bind policy can widen what `canRunCode` already refused. `not_local` keeps
 * Sprite envs on their existing path untouched. A revoked or disconnected
 * env refuses before policy is consulted: a bind never queues on a dead
 * machine.
 *
 * **A machine is driven by its OWNER only ([D-6], invariant 13).** The only
 * bind policy is `owner`: the user who enrolled the machine may bind, and
 * nobody else — not a drive admin, not the drive owner, not a member who
 * passed `canRunCode`. This is structural, not configurable: the values that
 * would have widened it (`admins`, `members`) are gone from the type, from
 * the schema's CHECK and from this function, and there is no actor ROLE in
 * the input at all, so no caller can widen the answer by resolving one. A
 * row somehow still holding a removed value falls to the default branch and
 * denies every non-owner; the owner still passes on their own hardware.
 * Drive admins keep Delete and Revoke; they never get Bind.
 *
 * `no_server_ops` comes LAST (GA wave 1): a bind to a machine whose
 * `serverPolicy` allows no operation would succeed and then have every grant
 * refused at signing (`decideSign`), so it fails here instead, with the one
 * reason the owner can fix on the settings page. Last, because it is the only
 * reason that is about what the machine may DO rather than whether this actor
 * may reach it at all. A `null` policy (missing, or refused by the strict
 * parser) counts as no ops — drift never widens.
 *
 * Pure: no db, no ws, no clock. `revokedAt` is judged by presence only.
 */
import type { CanRunCodeResult, CodeExecutionDenialReason } from '../services/sandbox/can-run-code';
import type { ServerPolicy } from './policy-types';

/** The closed bind-policy set: ONE value ([D-6]). Mirrors `DRIVE_ENV_BIND_POLICIES` on the schema; the gate test pins them equal. */
export type BindPolicy = 'owner';

export interface BindEnv {
  readonly ownerId: string;
  readonly substrate: string;
  readonly revokedAt: number | string | Date | null;
}

export interface DecideBindInput {
  readonly canRunCode: CanRunCodeResult;
  readonly bindPolicy: BindPolicy;
  /** The REQUESTER. Compared against `env.ownerId` and nothing else — there is deliberately no role here. */
  readonly actorId: string;
  readonly env: BindEnv;
  /** The env's `drive_env_local.serverPolicy`, parsed; `null` = deny-all. */
  readonly serverPolicy: ServerPolicy | null;
  /** Whether the env's bridge socket is live right now. */
  readonly connected: boolean;
  /** `LOCAL_ENVS_ENABLED` for this deployment. */
  readonly flagEnabled: boolean;
}

export type BindDenyReason = 'flag_disabled' | 'code_exec_denied' | 'not_local' | 'revoked' | 'not_connected' | 'bind_policy' | 'no_server_ops';

/** The documented, tested deny order. */
export const BIND_DENY_ORDER: readonly BindDenyReason[] = ['flag_disabled', 'code_exec_denied', 'not_local', 'revoked', 'not_connected', 'bind_policy', 'no_server_ops'];

export type BindVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: BindDenyReason; readonly cause?: CodeExecutionDenialReason };

function policyAllows(policy: BindPolicy, actorId: string, ownerId: string): boolean {
  if (actorId === ownerId) return true;
  switch (policy) {
    case 'owner':
      return false;
    default:
      // A removed (`admins`, `members`) or hostile value: drift never grants.
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
  if (!policyAllows(input.bindPolicy, input.actorId, input.env.ownerId)) return { ok: false, reason: 'bind_policy' };
  if (input.serverPolicy === null || input.serverPolicy.ops.length === 0) return { ok: false, reason: 'no_server_ops' };
  return { ok: true };
}
