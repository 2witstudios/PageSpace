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
  let timer: unknown = null;
  let disposed = false;
  // Rechecks run one after another: a timer fire and a policy-change nudge never interleave their leaves.
  let queue: Promise<void> = Promise.resolve();

  const disarm = () => {
    if (timer !== null) deps.clearTimer(timer);
    timer = null;
  };

  async function runRecheck(): Promise<void> {
    disarm();
    const actor = socket.data.actor;
    if (disposed || !actor || rooms.size === 0) return;
    const entries = [...rooms.entries()];
    const policies = await deps.readPolicies([...new Set(entries.map(([, resourceId]) => resourceId))]);
    if (disposed) return;
    const nowMs = deps.now();
    const plan = planOrgRoomExpiry({
      actor,
      rooms: entries.map(([room, resourceId]) => ({ room, resourceId, policy: policies.get(resourceId) ?? null })),
      nowMs,
    });
    for (const { room, resourceId, code } of plan.expired) {
      rooms.delete(room);
      socket.leave(room);
      deps.onLeft(room);
      socket.emit(ORG_REAUTHENTICATION_REQUIRED_EVENT, { code, resourceId });
    }
    if (plan.nextCheckAtMs !== null) {
      timer = deps.setTimer(() => void recheck(), Math.max(0, plan.nextCheckAtMs - nowMs));
    }
  }

  function recheck(): Promise<void> {
    queue = queue.then(runRecheck).catch((error: unknown) => {
      deps.onError(error);
      // A failed read must not leave held rooms unwatched: try again shortly.
      if (!disposed && rooms.size > 0) {
        disarm();
        timer = deps.setTimer(() => void recheck(), RETRY_AFTER_ERROR_MS);
      }
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
      disarm();
    },
  };
}
