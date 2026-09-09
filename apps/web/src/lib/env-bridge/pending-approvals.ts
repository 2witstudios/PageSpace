/**
 * Pending chat approvals, server side (GA wave 2, leaves 5–6).
 *
 * When a daemon answers a grant with `grant_denied ask_pending:<challengeId>`
 * it has FROZEN the request on the machine and is waiting for the owner's
 * click. The server remembers, under that id, what it would need to re-issue
 * the identical request when the click comes: the unsigned frame exactly as
 * it was sent, the principal it was sent for, the env, and the frozen request
 * the machine signed (for the card). Nothing here is an authorization: the
 * click is checked against `drive_env_local.ownerId` by the route, signed as
 * an `approvalIntent` on a fresh grant, and byte-compared by the MACHINE
 * against what IT froze. This map only lets the server ask the same question
 * again with the owner's answer attached.
 *
 * Bounded and TTL'd like the daemon's own challenge store: the TTL is the
 * grant's `exp` (the frozen request dies with it on the machine, so nothing
 * older could ever be honoured), eviction is synchronous on every access, and
 * a full map refuses to remember rather than evicting a live question.
 */
import type { GrantPrincipal } from '@pagespace/lib/env-bridge/grant';
import type { UnsignedGrantFrame } from '@pagespace/lib/env-bridge/grant-args';
import type { PendingApproval } from '@pagespace/lib/env-bridge/frame-codec';

export const MAX_PENDING_APPROVALS = 1024;

export interface PendingEnvApproval {
  readonly challengeId: string;
  readonly envId: string;
  /** The frame exactly as the server sent it; the click re-issues THIS. */
  readonly frame: UnsignedGrantFrame;
  /** The principal the request was made for; the click re-issues under the same one. */
  readonly principal: GrantPrincipal;
  /** The grant's exp — the machine's own TTL for the frozen request. */
  readonly expiresAt: number;
  /** The frozen request as the MACHINE signed it — what the card renders. */
  readonly pending: PendingApproval;
  readonly createdAt: number;
}

export interface PendingApprovalStore {
  remember(entry: PendingEnvApproval, now: number): boolean;
  get(challengeId: string, now: number): PendingEnvApproval | undefined;
  /** Consume: the click (or the deny) answers the question once. */
  take(challengeId: string, now: number): PendingEnvApproval | undefined;
  evictExpired(now: number): void;
  size(): number;
}

export function createPendingApprovalStore(max = MAX_PENDING_APPROVALS): PendingApprovalStore {
  const byId = new Map<string, PendingEnvApproval>();
  const evictExpired = (now: number) => {
    for (const [id, entry] of byId) if (entry.expiresAt < now) byId.delete(id);
  };
  return {
    remember(entry, now) {
      evictExpired(now);
      if (entry.expiresAt < now) return false;
      if (byId.has(entry.challengeId)) return true;
      if (byId.size >= max) return false;
      byId.set(entry.challengeId, entry);
      return true;
    },
    get(id, now) {
      evictExpired(now);
      return byId.get(id);
    },
    take(id, now) {
      evictExpired(now);
      const entry = byId.get(id);
      if (entry !== undefined) byId.delete(id);
      return entry;
    },
    evictExpired,
    size: () => byId.size,
  };
}

let singleton: PendingApprovalStore | null = null;

/** The process-wide store the bridge client writes and the approvals route reads. */
export function getPendingApprovalStore(): PendingApprovalStore {
  singleton ??= createPendingApprovalStore();
  return singleton;
}

export function resetPendingApprovalStoreForTesting(): void {
  singleton = null;
}
