/**
 * The SERVER-side gate every entry point runs before it would provision, bind
 * or attach anything for a `substrate: 'local'` environment (Codex C1: the
 * pure verdicts `decideBind` / `planLocalProvision` had no production caller,
 * so a local env fell straight into the Sprite provisioning path and the only
 * thing stopping it was UI gating).
 *
 * This module is IO-thin and decision-free: it reads the facts the two pure
 * planners need — the `drive_env_local` sibling, the live-socket reading, the
 * code-execution verdict, the actor's drive role, the cloud flag — and hands
 * them over. Every "may" and "is" is theirs:
 *
 *   decideBind        flag_disabled → code_exec_denied → not_local → revoked
 *                     → not_connected → bind_policy
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
import { decideBind, type ActorRole, type BindDenyReason, type BindPolicy } from '../../env-bridge/decide-bind';
import { planLocalProvision } from '../../env-bridge/plan-local-provision';
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
  /** The requester's role in the env's drive (owner/admin vs member) — the centralized helper in production. */
  resolveActorRole: () => Promise<ActorRole>;
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

  const bind = decideBind({
    canRunCode: await deps.canRunCode(),
    // The row's CHECK pins the closed set; anything else is a drifted row and
    // `decideBind` denies it as `bind_policy` (its default branch).
    bindPolicy: sibling.bindPolicy as BindPolicy,
    actorRole: await deps.resolveActorRole(),
    actorId: requesterId,
    env: { ownerId: sibling.ownerId, substrate: row.substrate, revokedAt: sibling.revokedAt },
    connected,
    flagEnabled: deps.flagEnabled,
  });
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

/**
 * The production role resolver: the centralized owner-or-admin helper, loaded
 * lazily so a caller that injects a fake never loads the permissions module
 * (and its database) at all. `decideBind` treats owner and admin alike, so
 * the helper's single boolean is exactly the distinction it needs.
 */
export async function resolveDriveActorRole({ userId, driveId }: { userId: string; driveId: string }): Promise<ActorRole> {
  const { isDriveOwnerOrAdmin } = await import('../../permissions/permissions');
  return (await isDriveOwnerOrAdmin(userId, driveId)) ? 'admin' : 'member';
}
