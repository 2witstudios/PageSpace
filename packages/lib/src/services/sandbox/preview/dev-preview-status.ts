/**
 * Dev-preview STATUS — what the UI renders, and the two things a user may do
 * to it (switch the preview off, switch it back on).
 *
 * The preview pane and the "Dev server detected on :5173 — Preview"
 * affordance are drawn from ONE read model, {@link DevPreviewStatus}, built
 * here by folding the core's answers — `describeServiceState` for the
 * preview, `describeHttpPortSlot` for the one 8080 slot — over the same
 * inputs the proxy's access gather already reads. Nothing in this module
 * decides anything the core does not: every `message` a user sees is either
 * the core's own copy or one of the fixed strings below, so honest wording
 * has exactly one home per fact.
 *
 * NEVER PROBE TO RENDER (binding — the core's docblock and spike §6). A
 * status render costs a control-plane attach and a control-plane service read
 * (`services.get`), both of which leave a paused sprite paused. The listener
 * snapshot is NOT fetched from the sprite: it is asked of the realtime tier,
 * which may already hold one from its `ports/watch` channel (the detection
 * registry), and `null` — no channel, no snapshot, realtime unreachable — is
 * a legitimate answer that renders the LAST-KNOWN state honestly: the relay's
 * own status carries the answer and the slot is reported as unknown, never
 * guessed. Rendering must be free, and it is.
 *
 * USER ACTIONS go through the core and the effects layer, adding no rule.
 * "Stop" writes `stoppedByUserAt` (the intent the platform cannot record —
 * spike §4) and then runs one reconcile with no fresh detection, which the
 * core turns into `stop-relay` if the relay is up. "Resume" clears the
 * intent and runs the same reconcile, which the core turns into a relay
 * restart on the row's own target (or `record-direct` for a server on 8080).
 * Both are the planner's decisions; this module only sequences the write
 * before the plan so the plan sees the intent it is acting on.
 */

import type { CanRunCodeResult } from '../can-run-code';
import type { SandboxHandle, SandboxServiceInfo } from '../sandbox-host';
import {
  DETECTION_UNAVAILABLE_MESSAGE,
  HTTP_PORT_BUSY_MESSAGE,
  describeHttpPortSlot,
  describeServiceState,
  planDevServerService,
  type DevPreviewHolderRef,
  type DevPreviewRow,
  type DevPreviewServiceState,
  type HttpPortSlotHolder,
  type ListeningPort,
} from './dev-preview-core';
import { applyDevServerServicePlan, type AppliedDevServerServicePlan } from './dev-preview-effects';
import { unlocked, type DevPreviewLock } from './dev-preview-lock';
import type { DevPreviewStore } from './dev-preview-store';
import { authorizePreviewHolder, type PreviewAccessDeps, type PreviewAuthorization } from './preview-access';
import { buildPreviewOpenPath } from './preview-grant';
import { PREVIEW_RELAY_SERVICE_NAME, SPRITE_HTTP_PORT } from './preview-relay';

// -----------------------------------------------------------------------------
// The read model
// -----------------------------------------------------------------------------

/**
 * The 8080 slot as the UI should explain it. `known: false` when no listener
 * snapshot is in hand — the slot is then simply not described, because a
 * guess dressed as a fact is exactly the dishonesty the never-probe rule
 * exists to prevent. `message` states the FACT (who holds the port); the
 * advice for a held slot has one home, the core's `HTTP_PORT_BUSY_MESSAGE`,
 * which the `blocked` state already carries.
 */
export type DevPreviewSlotReport =
  | { known: false }
  | { known: true; holder: HttpPortSlotHolder; pid: number | null; message: string };

/**
 * Whether DETECTION is running for this holder — orthogonal to what the
 * preview is doing, which is why it is a sibling field rather than a new
 * member of the core's state union (that union is mutation-tested and
 * switched on exhaustively by the UI copy).
 */
export type DevPreviewDetection = 'watching' | 'arming' | 'unavailable';

/** What the realtime tier answered: the snapshot it holds, and whether it is watching at all. */
export interface DevPreviewListenersRead {
  detection: DevPreviewDetection;
  listeners: readonly ListeningPort[] | null;
}

/** Whether the holder's sprite could be reached for this render. */
export type DevPreviewSandboxReach =
  /** The holder has no live sprite right now (never provisioned, torn down, session ended). */
  | 'absent'
  /** The holder names a sprite the platform could not attach to. */
  | 'unreachable'
  | 'attached';

export interface DevPreviewStatus {
  /** Whose preview this is — the env for an env-bound session (the holder rule). */
  holder: DevPreviewHolderRef;
  sandbox: DevPreviewSandboxReach;
  state: DevPreviewServiceState;
  slot: DevPreviewSlotReport;
  /**
   * The app-origin route that opens THIS reader's preview — the session's own
   * `/preview/open` when the user came through a session (it authorizes as
   * the session and mints for the holder), the env's otherwise. Null when the
   * env route cannot be named (no drive — impossible for an env, kept honest).
   */
  openPath: string | null;
  /** True when the preview is worth opening: the relay is up or coming up, or the server is on 8080 itself. */
  canOpen: boolean;
  /** True when a Stop control makes sense: there is a row on this instance and the user has not already stopped it. */
  canStop: boolean;
  /**
   * True when the preview can be (re)started by hand: the user switched it
   * off, or it is DOWN IN A WAY A RECONCILE REPAIRS — the core's
   * `down.repairable` (a crashed, missing or mis-pointed relay, or a
   * leftover relay in front of a direct row) — and one click should be able
   * to ask for it back rather than leaving the user waiting for a port frame
   * that may never come. Both go through the same `resume` action (clearing
   * an already-null stop intent is a no-op; the reconcile is the point).
   *
   * A `down` the reconcile CANNOT repair — the user's own dev server stopped
   * listening, so the planner answers `already-direct`/`already-relaying` —
   * deliberately offers nothing: a Restart that provably no-ops and leaves
   * the same button on screen is worse than no button, and the state's
   * message already says what actually has to happen.
   */
  canResume: boolean;
  /**
   * True when this reader may turn a detected-but-unshared port into a shared
   * one. The PORT is not carried beside it: `state` already names it when
   * this is true (`needs-approval` carries `targetPort`), and a second copy
   * of the same fact is a second thing that can disagree.
   */
  canApprove: boolean;
  /**
   * The sprite instance this status describes, or null when none is attached.
   * The approve action echoes it back, so consent cannot drift onto a VM that
   * replaced the one the user was looking at.
   */
  spriteInstanceId: string | null;
  /** When the dev server this row answers was detected, or null with no row. */
  detectedAt: Date | null;
  /**
   * Whether anything is watching this holder's ports right now. `unavailable`
   * means the status shown may be out of date — it is NOT a claim that the
   * sandbox is idle, which is exactly the conflation a bare `listeners: null`
   * used to force.
   */
  detection: DevPreviewDetection;
}

/**
 * The message for a holder with no live sprite — the one fact the core cannot
 * state, because `describeServiceState` is asked about a sprite. (A sprite
 * the platform could not ATTACH to is the core's own `instance-unknown`.)
 */
export const SANDBOX_ABSENT_MESSAGE = 'This sandbox is not running, so there is no dev server to preview.';
/**
 * Re-exported for server callers that already import this module. The value
 * itself lives in the pure core so the PANE can import it without pulling
 * this module's `node:crypto` and database dependencies into the browser
 * bundle — see the constant's own doc.
 */
export { DETECTION_UNAVAILABLE_MESSAGE };

/**
 * Pure: who holds 8080, as a fact. A user process on 8080 is the USER'S OWN
 * server when the row is direct (`targetPort === 8080`) — not "another
 * process" — and otherwise the intruder the core's busy message advises on
 * (that advice is not repeated here; it has one home).
 */
export function describeSlotMessage({ holder, pid, targetPort }: { holder: HttpPortSlotHolder; pid: number | null; targetPort: number | null }): string {
  const who = pid !== null ? ` (pid ${pid})` : '';
  switch (holder) {
    case 'none':
      return `Port ${SPRITE_HTTP_PORT} is free.`;
    case 'relay':
      return targetPort !== null && targetPort !== SPRITE_HTTP_PORT
        ? `Port ${SPRITE_HTTP_PORT} is held by the preview relay, forwarding to your dev server on port ${targetPort}.`
        : `Port ${SPRITE_HTTP_PORT} is held by the preview relay.`;
    case 'user-process':
      return targetPort === SPRITE_HTTP_PORT
        ? `Port ${SPRITE_HTTP_PORT} is held by your dev server${who}.`
        : `Port ${SPRITE_HTTP_PORT} is held by another process in the sandbox${who}.`;
  }
}

/** Re-exported beside the slot report so a reader of the fact can find the advice without importing the core. */
export { HTTP_PORT_BUSY_MESSAGE };

export interface BuildDevPreviewStatusInput {
  holder: DevPreviewHolderRef;
  sandbox: DevPreviewSandboxReach;
  /** The live instance id from the attached handle; null when not attached. */
  liveInstanceId: string | null;
  row: DevPreviewRow | null;
  /** The relay as the services API reports it; null when none is defined or nothing is attached. */
  relay: SandboxServiceInfo | null;
  /** The realtime tier's `ports/watch` snapshot, or null when none is in hand. */
  listeners: readonly ListeningPort[] | null;
  detection: DevPreviewDetection;
  openPath: string | null;
}

/** Pure: the whole read model from what the gather collected. */
export function buildDevPreviewStatus({ holder, sandbox, liveInstanceId, row, relay, listeners, detection, openPath }: BuildDevPreviewStatusInput): DevPreviewStatus {
  // Absent is the one reach the core cannot describe (it is asked about a
  // sprite); unreachable IS the core's `instance-unknown` (no live instance
  // id can be proven), so it is worded there and nowhere else.
  const state: DevPreviewServiceState =
    sandbox === 'absent'
      ? { status: 'none', message: SANDBOX_ABSENT_MESSAGE }
      : describeServiceState({ liveInstanceId: sandbox === 'attached' ? liveInstanceId : null, row, relay, listeners });

  let slot: DevPreviewSlotReport = { known: false };
  if (sandbox === 'attached' && listeners !== null) {
    const slotHolder = describeHttpPortSlot({ listeners, relay });
    const listener = listeners.find((entry) => entry.port === SPRITE_HTTP_PORT);
    const pid = slotHolder === 'user-process' && listener?.pid !== undefined ? listener.pid : null;
    slot = {
      known: true,
      holder: slotHolder,
      pid,
      message: describeSlotMessage({ holder: slotHolder, pid, targetPort: row?.targetPort ?? null }),
    };
  }

  // Only a row on THIS instance is something the user can act on: a stale
  // row's stop intent belongs to a dead VM (the core ignores it), and a row
  // with no live instance cannot be reconciled.
  const actionable = sandbox === 'attached' && row !== null && liveInstanceId !== null && row.spriteInstanceId === liveInstanceId;

  return {
    holder,
    sandbox,
    state,
    slot,
    openPath,
    canOpen: state.status === 'live' || state.status === 'starting',
    canStop: actionable && row.stoppedByUserAt === null,
    canResume: actionable && (row.stoppedByUserAt !== null || (state.status === 'down' && state.repairable)),
    canApprove: actionable && state.status === 'needs-approval',
    spriteInstanceId: sandbox === 'attached' ? liveInstanceId : null,
    detectedAt: row?.detectedAt ?? null,
    detection,
  };
}

// -----------------------------------------------------------------------------
// The gather
// -----------------------------------------------------------------------------

/** The realtime tier's listener snapshot for a holder's sprite, or null when it holds none (or cannot be asked). Never a probe. */
export type DevPreviewListenersReader = (holder: DevPreviewHolderRef) => Promise<DevPreviewListenersRead>;

export type DevPreviewStatusDeps = Pick<
  PreviewAccessDeps,
  'findSession' | 'findEnv' | 'resolveDriveMembership' | 'resolveDrivePayer' | 'attach' | 'previewStore'
> & {
  readListeners: DevPreviewListenersReader;
};

export type DevPreviewStatusResult =
  | { ok: true; status: DevPreviewStatus }
  | { ok: false; reason: 'not-authorized'; detail: string };

/**
 * Authorize (rows only — the same decider the proxy and the open routes run),
 * attach (control plane, never a wake), read the row, the relay and the
 * realtime tier's snapshot in parallel, fold.
 *
 * `authorizeAs` is the holder the user came THROUGH (a session, or the env
 * itself); `holder` is whose preview it is — the env for an env-bound
 * session. Authorization is the session's; the state is the holder's; the
 * open path is the session's route, because that route re-runs exactly this
 * authorization before minting for the holder.
 */
export async function gatherDevPreviewStatus({
  authorizeAs,
  holder,
  userId,
  deps,
}: {
  authorizeAs: DevPreviewHolderRef;
  holder: DevPreviewHolderRef;
  userId: string;
  deps: DevPreviewStatusDeps;
}): Promise<DevPreviewStatusResult> {
  const authorization: PreviewAuthorization = await authorizePreviewHolder({ holder: authorizeAs, userId, deps });
  if (!authorization.allowed) return { ok: false, reason: 'not-authorized', detail: authorization.reason };
  const openPath = buildPreviewOpenPath(authorizeAs, authorization.driveId);

  if (authorization.sandboxId === null) {
    const row = await deps.previewStore.findByHolder(holder);
    // Realtime is deliberately not asked about a holder with no sprite.
    return { ok: true, status: buildDevPreviewStatus({ holder, sandbox: 'absent', liveInstanceId: null, row, relay: null, listeners: null, detection: 'unavailable', openPath }) };
  }

  const [handle, row, read] = await Promise.all([
    deps.attach(authorization.sandboxId),
    deps.previewStore.findByHolder(holder),
    deps.readListeners(holder),
  ]);
  if (handle === null) {
    return { ok: true, status: buildDevPreviewStatus({ holder, sandbox: 'unreachable', liveInstanceId: null, row, relay: null, listeners: null, detection: read.detection, openPath }) };
  }
  const relay = await handle.services.get(PREVIEW_RELAY_SERVICE_NAME);
  return {
    ok: true,
    status: buildDevPreviewStatus({ holder, sandbox: 'attached', liveInstanceId: handle.spriteInstanceId, row, relay, listeners: read.listeners, detection: read.detection, openPath }),
  };
}

// -----------------------------------------------------------------------------
// User actions
// -----------------------------------------------------------------------------

/**
 * What a user may do to a preview. A discriminated union rather than a bare
 * string because `approve` carries the PORT the user was shown: echoing it
 * back is what binds the click to the thing on screen, so a dev server that
 * moved between the render and the click can never be shared by a click that
 * meant the old one.
 */
export type DevPreviewUserAction =
  | { kind: 'stop' }
  | { kind: 'resume' }
  | {
      kind: 'approve';
      port: number;
      /**
       * The sprite INSTANCE the decision was made against. Echoed for the same
       * reason `port` is: a rebuild replaces the row and can detect the same
       * port again, so a click made against the old sandbox would otherwise
       * approve a different VM's server of the same number.
       */
      spriteInstanceId: string;
    };

export interface DevPreviewUserActionDeps {
  previewStore: DevPreviewStore;
  /** A control-plane attach to the holder's LIVE sprite by name; null when the platform no longer has it. Must not wake. */
  attach(sandboxId: string): Promise<SandboxHandle | null>;
  readListeners: DevPreviewListenersReader;
  /** The centralized code-execution gate — consulted on every RESUME (see below). */
  canRunCode(input: { userId: string; driveId: string | null; ownerId: string }): Promise<CanRunCodeResult>;
  /**
   * Serializes this holder's read → plan → apply against the realtime
   * detector's. Defaults to no serialization (pure unit surfaces); the web
   * binding supplies the real Postgres advisory lock.
   */
  lock?: DevPreviewLock;
  now(): Date;
}

export type DevPreviewUserActionResult =
  /** The intent is recorded and the relay was reconciled (or there was nothing to reconcile). */
  /**
   * `lockContended` means the INTENT was recorded but the relay work was
   * deferred — the detector held this holder's lock past the retry budget, or
   * the lock pool was degraded. Deliberately not an `ok: false` reason: the
   * action-response helper maps unrecognised refusals onto "no preview to
   * switch", which would be a lie about a click that took effect.
   */
  | { ok: true; applied: AppliedDevServerServicePlan | null; lockContended?: true }
  /** The holder has no preview row — nothing to switch. */
  | { ok: false; reason: 'no-preview' }
  /** A RESUME the holder's payer may not spend compute on — the wake gate said no. Nothing was written. */
  | { ok: false; reason: 'wake-not-allowed'; detail: string }
  /**
   * A RESUME that would start a relay while no current `ports/watch`
   * snapshot proves 8080 is free (the watcher is starting up or
   * reconnecting). The intent IS cleared — the user's "on" stands — and the
   * detector's next frame starts the relay against a real snapshot; the
   * caller should say "starting shortly" rather than claim a failure.
   */
  | { ok: false; reason: 'slot-unknown' }
  /**
   * An `approve` whose echoed port is not the port the row targets any more.
   * Nothing was written: the user agreed to share something else than what is
   * running now, and the honest answer is to show them the new port.
   */
  | { ok: false; reason: 'port-changed' }
  /**
   * An `approve` whose echoed sprite INSTANCE is not the one the row belongs
   * to any more: the sandbox was rebuilt between the render and the click.
   * Kept separate from `port-changed` because the port may be identical — a
   * replacement VM commonly re-detects the same one — and telling the user
   * their server moved ports would be a plainly false sentence.
   */
  | { ok: false; reason: 'instance-changed' };

/**
 * Record the intent, then reconcile ONCE through the core and the effects
 * layer. The caller has already authorized the write (a session-access or
 * drive owner/admin decision — see the routes); this function trusts it.
 *
 * The write lands BEFORE the plan on purpose: the plan reads the row and must
 * see the intent it is carrying out. If the sprite cannot be attached the
 * intent still stands (`applied: null`) — a stop is honoured by the planner
 * on the next detection regardless, and a resume is honoured the moment the
 * detector next reconciles — so the caller can report the switch truthfully
 * while saying the relay itself was not touched.
 *
 * The listener snapshot is folded in when the realtime tier has one so a
 * resume against a slot a user process has since taken is REFUSED by the
 * core (`http-port-busy`) rather than planned into a relay that cannot bind.
 * With no snapshot the core plans against an empty listener set, which is
 * the same self-correcting posture the detector takes.
 */
export async function applyDevPreviewUserAction({
  holder,
  action,
  userId,
  wakeSubject,
  deps,
}: {
  holder: DevPreviewHolderRef;
  action: DevPreviewUserAction;
  /** Who is acting — the subject of the wake gate. */
  userId: string;
  /** Who PAYS for compute in this holder's drive — `PreviewAuthorization.wakeSubject`, the same input a session ensure gives `canRunCode`. */
  wakeSubject: { driveId: string | null; ownerId: string };
  deps: DevPreviewUserActionDeps;
}): Promise<DevPreviewUserActionResult> {
  const now = deps.now();
  const lock = deps.lock ?? unlocked;
  // Bound once: the locked path and the contended fallback make the SAME
  // write, and only where it happens differs.
  const writeIntent = () => writeDevPreviewIntent({ holder, action, now, userId, store: deps.previewStore });

  // RESUME IS COMPUTE. `services.start` brings a process up inside the sprite
  // and, on a suspended sprite, is a billed wake — the same posture the proxy
  // applies before forwarding into a paused sprite (`decidePreviewForward` →
  // `canRunCode`). It is asked on EVERY resume, not only when the sprite is
  // known to be paused: a payer whose code-execution has been revoked must
  // not be able to restart anything, and "is it paused right now" is a race
  // the gate should not depend on. Asked BEFORE the intent is cleared, on
  // purpose: a refused resume that had already cleared `stoppedByUserAt`
  // would leave the row "on", and the detector's next frame would restart
  // the relay anyway — the exact bypass the gate exists to close.
  // An APPROVE is the same kind of act — it exists to make the relay start —
  // so it is gated identically.
  if (action.kind === 'resume' || action.kind === 'approve') {
    const wake = await deps.canRunCode({ userId, ...wakeSubject });
    if (!wake.ok) return { ok: false, reason: 'wake-not-allowed', detail: wake.reason };
  }

  // ONE CRITICAL SECTION, serialized per holder against the realtime
  // detector (`dev-preview-lock.ts`). The two writers used to interleave
  // read → plan → apply freely; the comment that stood here argued the window
  // was one frame wide and self-correcting, which was wrong on both counts —
  // convergence assumed a later frame that may never come. Under the lock the
  // plan is made from the row it acts on.
  const locked = await lock(holder, async (): Promise<DevPreviewUserActionResult> => {
    // The write returns the row as written, and the plan is made from THAT —
    // no second read.
    const written = await writeIntent();
    if (!written.ok) return written;
    const row = written.row;

    const handle = await deps.attach(row.sandboxId);
    if (handle === null) return { ok: true, applied: null };

    const [relay, read] = await Promise.all([handle.services.get(PREVIEW_RELAY_SERVICE_NAME), deps.readListeners(holder)]);
    const listeners = read.listeners;
    // `listeners: null` is UNKNOWN, never "nothing is bound". Coercing it to an
    // empty set would let the core read 8080 as free and start a relay that may
    // fail to bind; `listenersKnown` makes the core refuse that instead, and the
    // detector — which plans on a frame it just saw — starts it a moment later.
    const plan = planDevServerService({
      liveInstanceId: handle.spriteInstanceId,
      sandboxId: handle.sandboxId,
      row,
      holder,
      detected: null,
      relay,
      listeners: listeners ?? [],
      listenersKnown: listeners !== null,
      now,
    });
    if (plan.action === 'refuse' && plan.reason === 'slot-unknown') return { ok: false, reason: 'slot-unknown' };
    const applied = await applyDevServerServicePlan({ plan, services: handle.services, store: deps.previewStore });
    return { ok: true, applied };
  });
  if (locked.outcome === 'acquired') return locked.result;

  // CONTENDED (or the lock pool is degraded). The user's INTENT is what they
  // are entitled to, so record it unserialized — the row's compare-and-set
  // keeps that write safe on its own — and defer the relay work to the
  // detector's next frame or the backstop sweep.
  const contended = await writeIntent();
  if (!contended.ok) return contended;
  return { ok: true, applied: null, lockContended: true };
}

/**
 * The one durable write a user action makes, before any plan: the stop
 * intent, or the approval. Returns the row AS WRITTEN so the plan can be made
 * from it without a second read, or the refusal to hand straight back.
 */
async function writeDevPreviewIntent({
  holder,
  action,
  now,
  userId,
  store,
}: {
  holder: DevPreviewHolderRef;
  action: DevPreviewUserAction;
  now: Date;
  userId: string;
  store: DevPreviewStore;
}): Promise<{ ok: true; row: DevPreviewRow } | Extract<DevPreviewUserActionResult, { reason: 'port-changed' | 'instance-changed' | 'no-preview' }>> {
  if (action.kind !== 'approve') {
    const row = await store.setStoppedByUser(holder, action.kind === 'stop' ? now : null);
    return row === null ? { ok: false, reason: 'no-preview' } : { ok: true, row };
  }
  const approved = await store.approvePort(holder, { port: action.port, spriteInstanceId: action.spriteInstanceId, at: now, byUserId: userId });
  if (approved !== null) return { ok: true, row: approved };
  // Null means the filtered UPDATE matched nothing, and the three causes read
  // very differently to a user. Re-read to say which: no row at all, the
  // server moved to another port, or the sandbox was rebuilt under it. The
  // last is the one the instance echo was added for, and its port is usually
  // UNCHANGED — reporting it as "moved to a different port" would be false.
  const row = await store.findByHolder(holder);
  if (row === null) return { ok: false, reason: 'no-preview' };
  if (row.spriteInstanceId !== action.spriteInstanceId) return { ok: false, reason: 'instance-changed' };
  return { ok: false, reason: 'port-changed' };
}
