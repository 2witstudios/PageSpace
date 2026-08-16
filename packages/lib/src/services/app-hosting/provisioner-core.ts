/**
 * provisioner-core — the PURE decision layer for published-app provisioning.
 *
 * INVARIANT: this module has zero I/O. No db, no fetch, no env, no clock. Every
 * input is an explicit argument; every output is a value, and nothing throws. All
 * lifecycle decisions live here so they can be tested exhaustively and
 * deterministically; `provisioner.ts` is the imperative shell that reads state,
 * calls these functions, and persists the result. The purity invariant is enforced
 * by a test in __tests__ — the same arrangement as billing's credit-core.
 */

import type { PublishedAppStatus } from '@pagespace/db/schema/published-apps';

/**
 * The Fly app name for a published app.
 *
 * Derived from the row id, which is a cuid2 generated BEFORE the Fly call — that
 * ordering is what lets us name the resource we're about to create and record the
 * name in the same transaction, so a crash mid-provision leaves a pointer rather
 * than an orphan.
 *
 * There is deliberately NO `networkNameFor(id)` beside this. Every published app
 * shares one network (see `resolvePublishedAppsNetwork`), because fly-replay
 * cannot cross networks — per-app networks return `502 cross-network replays are
 * not allowed` and would break the routing tier outright.
 */
export function flyAppNameFor(publishedAppId: string): string {
  return `pgs-app-${publishedAppId}`;
}

/**
 * States from which no further work is scheduled. `failed` is terminal for the
 * automatic pipeline but recoverable by an explicit retry, which re-enters at
 * `provisioning` — that edge is in the transition table below.
 */
export const TERMINAL_STATUSES: readonly PublishedAppStatus[] = ['failed', 'destroying'];

export function isTerminal(status: PublishedAppStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * The legal status edges, as data.
 *
 * Encoded as a table rather than scattered `if` statements so the whole machine is
 * reviewable in one place and every edge is testable. Two rules shape it:
 *  - `destroying` is reachable from ANY live state — teardown must never be blocked
 *    by whatever the app happened to be doing, or a user's delete (or a GDPR
 *    erasure) could be refused by a stuck build.
 *  - `failed` is likewise reachable from any state that performs work, because any
 *    of those steps can fail.
 */
export const PUBLISHED_APP_TRANSITIONS: Readonly<
  Record<PublishedAppStatus, readonly PublishedAppStatus[]>
> = {
  provisioning: ['building', 'destroying', 'failed'],
  building: ['deploying', 'destroying', 'failed'],
  deploying: ['running', 'destroying', 'failed'],
  // A running app is stopped by the idle reaper, parked by the credit gate, or
  // redeployed (blue/green) — which re-enters at building.
  running: ['stopped', 'parked', 'building', 'destroying', 'failed'],
  // A stopped app wakes on the next request, is parked when credits run out, or is
  // redeployed while cold.
  stopped: ['running', 'parked', 'building', 'destroying', 'failed'],
  // Parked is enforcement, not a fault: it clears to `stopped` when credits return,
  // and the app then wakes normally on the next request. It never goes straight to
  // `running`, because resuming still has to go through the wake path.
  parked: ['stopped', 'destroying', 'failed'],
  // Terminal. A destroying row is deleted once the Fly app is confirmed gone.
  destroying: [],
  // An explicit retry re-enters the pipeline; teardown is always available.
  failed: ['provisioning', 'destroying'],
};

export type TransitionRefusal = 'same_state' | 'terminal_state' | 'illegal_transition';

export type TransitionPlan =
  | { allowed: true }
  | { allowed: false; reason: TransitionRefusal };

/**
 * Decide whether a status change is legal. Never throws — an illegal transition is
 * a value the caller reports, not an exception, because these are driven by cron
 * ticks and user actions racing each other and a refusal is an ordinary outcome.
 */
export function planTransition(
  from: PublishedAppStatus,
  to: PublishedAppStatus,
): TransitionPlan {
  if (from === to) return { allowed: false, reason: 'same_state' };
  if (PUBLISHED_APP_TRANSITIONS[from].length === 0) {
    return { allowed: false, reason: 'terminal_state' };
  }
  if (!PUBLISHED_APP_TRANSITIONS[from].includes(to)) {
    return { allowed: false, reason: 'illegal_transition' };
  }
  return { allowed: true };
}

export type ProvisionDenial = 'disabled' | 'already_exists';

export type ProvisionPlan =
  | { action: 'create' }
  /** A row already exists and is healthy — provisioning is a no-op, not an error. */
  | { action: 'noop'; existingStatus: PublishedAppStatus }
  | { action: 'deny'; reason: ProvisionDenial };

/**
 * Decide what `createPublishedApp` should actually do.
 *
 * The kill switch is checked FIRST and denies before anything else is considered,
 * so a disabled deployment cannot be talked into provisioning by any combination of
 * existing state.
 *
 * An existing `failed` row is re-drivable: provisioning it again is the retry path,
 * which is why it plans `create` rather than `noop`. Any other existing row is a
 * no-op — the app is already in the pipeline, and re-provisioning would create a
 * second Fly app for the same page.
 */
export function planProvision({
  enabled,
  existingStatus,
}: {
  enabled: boolean;
  existingStatus?: PublishedAppStatus | null;
}): ProvisionPlan {
  if (!enabled) return { action: 'deny', reason: 'disabled' };
  if (existingStatus === undefined || existingStatus === null) return { action: 'create' };
  if (existingStatus === 'failed') return { action: 'create' };
  return { action: 'noop', existingStatus };
}
