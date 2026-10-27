/**
 * The thin shell around planOrgRoomExpiry: one watch per socket, tracking the org-gated rooms it joined and keeping
 * ONE timer armed at the earliest moment any of them expires for the socket's credential (SEC-3). When it fires, or
 * when the server hears an org's policy changed, every tracked room is re-decided against the policy read NOW, and
 * the rooms the credential no longer satisfies are left with `org:reauthentication_required` {code, resourceId}.
 */
import type { AccessActor } from '@pagespace/lib/permissions/access-actor';
import { planOrgRoomExpiry, type JoinedOrgRoom } from './org-room-expiry';

export const ORG_REAUTHENTICATION_REQUIRED_EVENT = 'org:reauthentication_required';

const RETRY_AFTER_ERROR_MS = 60_000;

export interface OrgRoomWatchSocket {
  data: { actor?: AccessActor };
  leave(room: string): void;
  emit(event: string, payload: unknown): void;
}

export interface OrgRoomWatchDeps {
  /** The sign-in policy governing each resource (page or drive id); null where no org governs. Read live. */
  readPolicies(resourceIds: readonly string[]): Promise<Map<string, JoinedOrgRoom['policy']>>;
  /** Called after the watch leaves a room, so the caller's room bookkeeping follows. */
  onLeft(room: string): void;
  now(): number;
  setTimer(run: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
  onError(error: unknown): void;
}

export interface OrgRoomWatch {
  track(room: string, resourceId: string): Promise<void>;
  untrack(room: string): void;
  recheck(): Promise<void>;
  dispose(): void;
}

export function createOrgRoomWatch(socket: OrgRoomWatchSocket, deps: OrgRoomWatchDeps): OrgRoomWatch {
  const rooms = new Map<string, string>();
  const knownPolicies = new Map<string, JoinedOrgRoom['policy']>();
  let timer: unknown = null;
  let disposed = false;
  // Rechecks run one after another: a timer fire and a policy-change nudge never interleave their leaves.
  let queue: Promise<void> = Promise.resolve();

  const disarm = () => {
    if (timer !== null) deps.clearTimer(timer);
    timer = null;
  };

  function enforcePolicies(policies: Map<string, JoinedOrgRoom['policy']>, retryAfterError = false): void {
    const actor = socket.data.actor;
    if (disposed || !actor || rooms.size === 0) return;
    const nowMs = deps.now();
    const plan = planOrgRoomExpiry({
      actor,
      rooms: [...rooms].map(([room, resourceId]) => ({ room, resourceId, policy: policies.get(resourceId) ?? null })),
      nowMs,
    });
    for (const { room, resourceId, code } of plan.expired) {
      rooms.delete(room);
      socket.leave(room);
      deps.onLeft(room);
      socket.emit(ORG_REAUTHENTICATION_REQUIRED_EVENT, { code, resourceId });
    }
    const retryAtMs = retryAfterError && rooms.size > 0 ? nowMs + RETRY_AFTER_ERROR_MS : null;
    const nextCheckAtMs = plan.nextCheckAtMs === null ? retryAtMs
      : retryAtMs === null ? plan.nextCheckAtMs : Math.min(plan.nextCheckAtMs, retryAtMs);
    if (nextCheckAtMs !== null) {
      timer = deps.setTimer(() => {
        disarm();
        enforcePolicies(knownPolicies);
        void recheck();
      }, Math.max(0, nextCheckAtMs - nowMs));
    }
  }

  async function runRecheck(): Promise<void> {
    disarm();
    if (disposed || !socket.data.actor || rooms.size === 0) return;
    // Known credential expiry cannot depend on a successful policy lookup.
    enforcePolicies(knownPolicies);
    if (rooms.size === 0) return;
    const resourceIds = [...new Set(rooms.values())];
    const policies = await deps.readPolicies(resourceIds);
    if (disposed) return;
    for (const resourceId of resourceIds) knownPolicies.set(resourceId, policies.get(resourceId) ?? null);
    disarm();
    enforcePolicies(knownPolicies);
  }

  function recheck(): Promise<void> {
    queue = queue.then(runRecheck).catch((error: unknown) => {
      deps.onError(error);
      // Preserve the last successfully read policy and retry no later than its known deadline.
      disarm();
      enforcePolicies(knownPolicies, true);
    });
    return queue;
  }

  return {
    async track(room, resourceId) {
      rooms.set(room, resourceId);
      await recheck();
    },
    untrack(room) {
      rooms.delete(room);
    },
    recheck,
    dispose() {
      disposed = true;
      rooms.clear();
      knownPolicies.clear();
      disarm();
    },
  };
}

export interface PolicyChangeFanoutDeps {
  /** Every live watch on this process, read at fan-out time. */
  watches(): Iterable<OrgRoomWatch>;
  now(): number;
  /** Legacy fan-out settings retained for callers; notices carry no reliable revision identity. */
  windowMs: number;
}

/**
 * An org's sign-in policy changed (SEC-2/3): re-decide EVERY watch on this process, not only the org's members' — a
 * guest or former member can hold a room in one of the org's drives, and the policy binds them too. A watch holding
 * no rooms returns without reading anything, so the fan-out costs one policy read per socket that holds a room.
 * Notices may repeat per member, but have no event identity: every notice queues a recheck so a distinct tightening
 * cannot disappear, including when another recheck is already running.
 */
export function createPolicyChangeFanout(deps: PolicyChangeFanoutDeps): (orgId: string) => void {
  return () => {
    for (const watch of deps.watches()) void watch.recheck();
  };
}
