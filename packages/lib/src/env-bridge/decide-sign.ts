/**
 * May the server SIGN a grant for this op on this local environment?
 * (invariant 4 — the server's say in the three-way intersection)
 *
 * The grant IS the capability: a daemon runs nothing without a signature
 * over `op`, so refusing to mint is the server's forced-command. Before this
 * gate existed the server signed any op it was asked to sign and
 * `serverPolicy` was a column nothing read; PageSpace's say in what may run
 * on an enrolled machine was zero. `EnvBridgeClient.sendGrant` consults this
 * BEFORE `signGrantFrame`, and on a refusal the signing key is never touched.
 *
 * Fixed deny order, tested per adjacent pair like `decide-bind.ts`:
 *
 *   flag_disabled → revoked → paused → server_denied
 *
 * The cloud opt-in comes first so a deployment that has not enabled local
 * envs never evaluates anything else; a revoked env refuses before its policy
 * is read; `paused` is RESERVED now for the Stop button (a later wave feeds
 * it) so the order is settled once and never re-litigated; the policy is
 * last because it is the only reason the owner can change from the settings
 * page.
 *
 * Fail closed: a `null` policy (missing sibling, or a stored value the strict
 * parser refused — see `parseServerPolicy`) and an empty `ops` list (the
 * column's deny-by-default backstop) both deny. There is no permissive path
 * for "should not happen".
 *
 * Pure: no db, no ws, no clock, no crypto. `envRevoked` is a presence fact
 * the caller derives from `revokedAt`.
 */
import type { GrantOp } from './grant';
import type { ServerPolicy } from './policy-types';

export interface DecideSignInput {
  readonly op: GrantOp;
  /** The env's `drive_env_local.serverPolicy`, parsed; `null` = deny-all. */
  readonly serverPolicy: ServerPolicy | null;
  /** `drive_env_local.revokedAt !== null` — or no sibling at all (a dead local env). */
  readonly envRevoked: boolean;
  /** The Stop button's flag (reserved; nothing sets it yet). Omitted = not paused. */
  readonly paused?: boolean;
  /** `LOCAL_ENVS_ENABLED` for this deployment. */
  readonly flagEnabled: boolean;
}

export type SignDenyReason = 'flag_disabled' | 'revoked' | 'paused' | 'server_denied';

/** The documented, tested deny order. */
export const SIGN_DENY_ORDER: readonly SignDenyReason[] = ['flag_disabled', 'revoked', 'paused', 'server_denied'];

export type SignVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: SignDenyReason };

/** @returns `ok`, or the first deny reason in `SIGN_DENY_ORDER` that applies. */
export function decideSign(input: DecideSignInput): SignVerdict {
  if (!input.flagEnabled) return { ok: false, reason: 'flag_disabled' };
  if (input.envRevoked) return { ok: false, reason: 'revoked' };
  if (input.paused === true) return { ok: false, reason: 'paused' };
  if (input.serverPolicy === null || !input.serverPolicy.ops.includes(input.op)) return { ok: false, reason: 'server_denied' };
  return { ok: true };
}
