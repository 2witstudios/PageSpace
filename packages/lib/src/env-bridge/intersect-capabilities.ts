/**
 * Effective capability = advertised ∩ server-allowed ∩ machine-allowed
 * (invariant 4). No single party can grant an operation on its own: the
 * machine must be able to do it, the drive must allow it for this env, and the
 * machine owner must allow it locally. Checkpoints follow the same rule and are
 * additionally never assumed — a local env that cannot snapshot its filesystem
 * must say so, and the checkpoint-policy layer fails closed on it (invariant 12).
 */
import { GRANT_OPS, type GrantOp } from './grant';
import type { AdvertisedCapabilities, AllowedOperations, EffectiveCapabilities } from './policy-types';

export type CapabilityName = Exclude<keyof AdvertisedCapabilities, 'checkpoint'>;

/** Which advertised capability an operation needs. Every op maps to exactly one. */
export function capabilityForOp(op: GrantOp): CapabilityName {
  switch (op) {
    case 'exec':
      return 'shell';
    case 'fs_read':
    case 'fs_write':
      return 'fs';
    case 'pty_open':
      return 'pty';
  }
}

export function intersectCapabilities(
  advertised: AdvertisedCapabilities,
  server: AllowedOperations,
  machine: AllowedOperations,
): EffectiveCapabilities {
  const serverOps = new Set(server.ops);
  const machineOps = new Set(machine.ops);
  const ops = Object.fromEntries(
    GRANT_OPS.map((op) => [op, advertised[capabilityForOp(op)] && serverOps.has(op) && machineOps.has(op)]),
  ) as Record<GrantOp, boolean>;
  return {
    ...ops,
    checkpoint: advertised.checkpoint && server.checkpoint && machine.checkpoint,
  };
}
