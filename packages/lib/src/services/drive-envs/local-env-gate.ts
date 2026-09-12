/**
 * The SERVER-side gate every entry point runs before it would provision, bind
 * or attach anything for a `substrate: 'local'` environment (Codex C1: the
 * pure verdicts `decideBind` / `planLocalProvision` had no production caller,
 * so a local env fell straight into the Sprite provisioning path and the only
 * thing stopping it was UI gating).
 *
 * This module is IO-thin and decision-free: it reads the facts the two pure
 * planners need — the `drive_env_local` sibling, the live-socket reading, the
 * code-execution verdict, the cloud flag — and hands them over. There is NO
 * role lookup here any more ([D-6]): binding is the env owner's alone, so the
 * requester's drive role is not an input to anything and is never fetched.
 * Every "may" and "is" is the planners':
 *
 *   decideBind        flag_disabled → code_exec_denied → not_local → revoked
 *                     → not_connected → bind_policy → no_server_ops
 *   planLocalProvision  revoked → not_connected → attach_local
 *
 * A sibling that is missing means the owner was erased (Art 17 cascades the
 * machine's identity facts) — the env survives as a dead local env and is
 * treated as revoked. `connected` is the same READING the listing shows
 * (`deriveLocalEnvStatus`): the live registry wins, otherwise a fresh
 * heartbeat counts.
 *
 * The verdict is typed. `ok` means "this actor may bind to this live machine";
 * whether anything can then be attached is the provisioner's question — until
 * the local `SandboxHost` lands (t09) it answers `substrate_unsupported`, and
 * NEVER falls through to the Sprite host.
 */
import { decideBind, type BindDenyReason, type BindPolicy } from '../../env-bridge/decide-bind';
import { planLocalProvision } from '../../env-bridge/plan-local-provision';
import { parseServerPolicy } from '../../env-bridge/policy-types';
import type { CanRunCodeResult, CodeExecutionDenialReason } from '../sandbox/can-run-code';
import { deriveLocalEnvStatus } from './drive-envs';
import type { DriveEnvRecord, DriveEnvStore } from './drive-envs-store';

/** Every way a local env refuses at the server; `substrate_unsupported` is the provisioner's word for "allowed, but nothing here can attach yet". */
export type LocalEnvRefusal = BindDenyReason | 'substrate_unsupported';

/** This replica's bridge-socket registry reading for an env; `null` = no live socket here. */
export type LiveConnectionReader = (envId: string) => 'connecting' | 'connected' | null;

/** Until the socket route (t07) exists there is no registry: status derives from the heartbeat alone. */
export const noLiveConnections: LiveConnectionReader = () => null;

export interface LocalEnvGateDeps {
  store: Pick<DriveEnvStore, 'findLocalByEnvId'>;
  /** The centralized code-execution gate, already bound to this requester, drive and payer. */
  canRunCode: () => Promise<CanRunCodeResult>;
  liveConnection: LiveConnectionReader;
  /** `LOCAL_ENVS_ENABLED` for this deployment. */
  flagEnabled: boolean;
  now: () => Date;
}

export type LocalEnvGateVerdict =
  | { ok: true; envId: string }
  | { ok: false; refusal: LocalEnvRefusal; cause?: CodeExecutionDenialReason };

/**
 * May `requesterId` bind to / provision this LOCAL env right now?
 * @returns `ok` when both pure planners allow, else the first refusal in their fixed order.
 */
export async function gateLocalEnv({
  row,
  requesterId,
  deps,
}: {
  row: Pick<DriveEnvRecord, 'id' | 'substrate'>;
  requesterId: string;
  deps: LocalEnvGateDeps;
}): Promise<LocalEnvGateVerdict> {
  const sibling = await deps.store.findLocalByEnvId(row.id);
  // No sibling: the owner was erased and the machine's identity with them. Dead env.
  if (!sibling) return { ok: false, refusal: 'revoked' };

  const now = deps.now().getTime();
  const connected =
    deriveLocalEnvStatus({
      enrolledAt: sibling.enrolledAt,
      revokedAt: sibling.revokedAt,
      lastSeenAt: sibling.lastSeenAt,
      liveConnection: deps.liveConnection(row.id),
      now,
    }) === 'connected';

  const facts = {
    // The row's CHECK pins the closed set; anything else is a drifted row and
    // `decideBind` denies it as `bind_policy` (its default branch).
    bindPolicy: sibling.bindPolicy as BindPolicy,
    actorId: requesterId,
    env: { ownerId: sibling.ownerId, substrate: row.substrate, revokedAt: sibling.revokedAt },
    // The sibling already in hand — no second read (GA wave 1). Parsed
    // strictly: a stored value the parser refuses is `null`, which the
    // planner denies as `no_server_ops`.
    serverPolicy: parseServerPolicy(sibling.serverPolicy),
    connected,
    flagEnabled: deps.flagEnabled,
  };

  // `decideBind` is consulted in two stages so that NO IO runs that cannot
  // change its verdict, and its documented deny order is what the caller
  // observes (Codex P2 on #2537): the flag alone first — a disabled deployment
  // does no authorization work at all — then the code-exec gate. The flag
  // probe supplies an `ok` code-exec verdict, the value under which the
  // planner is MOST permissive, so any refusal it returns is independent of
  // that input and final; an `ok` is never returned until every input is real.
  const flagProbe = decideBind({ ...facts, canRunCode: { ok: true } });
  if (!flagProbe.ok && flagProbe.reason === 'flag_disabled') return { ok: false, refusal: flagProbe.reason };

  const bind = decideBind({ ...facts, canRunCode: await deps.canRunCode() });
  if (!bind.ok) return { ok: false, refusal: bind.reason, cause: bind.cause };

  const plan = planLocalProvision({ env: { id: row.id, substrate: row.substrate, revokedAt: sibling.revokedAt }, connected });
  switch (plan.kind) {
    case 'attach_local':
      return { ok: true, envId: plan.envId };
    case 'revoked':
    case 'not_connected':
      return { ok: false, refusal: plan.kind };
    case 'not_local':
      // Unreachable after decideBind's `not_local`, kept so the switch is total.
      return { ok: false, refusal: 'substrate_unsupported' };
  }
}
