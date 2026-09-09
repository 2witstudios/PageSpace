/**
 * Dev-preview DECISION CORE — pure planners, zero IO.
 *
 * A dev server running inside a sandbox Sprite (a session's or an env's) is
 * offered as a live preview through PageSpace's same-origin authenticated
 * proxy. Four questions have to be answered on every port notification and
 * every reconcile, and all four are answered HERE, from data, with nothing
 * but the answer for the effects layer (the proxy task) to carry out:
 *
 *  - {@link classifyDetectedDevServer} — is this `port_opened` a dev server
 *    worth offering, or our own relay binding 8080, or a database?
 *  - {@link isHttpPortSlotFree} — is 8080 free: no relay, no user process?
 *  - {@link planDevServerService} — start the relay / re-point it / do
 *    nothing / refuse, and why.
 *  - {@link describeServiceState} — the row folded with the live service
 *    read, as one status the UI can render without knowing any of the above.
 *
 * GROUND TRUTH THIS MODULE IS BUILT ON (docs/spikes/2026-08-dev-preview-sprite-services-spike.md)
 * ----------------------------------------------------------------------------------------------
 *  - The sprite URL proxies to port 8080, always; `httpPort` does not route,
 *    there is no one-port 409, no start-on-request (§3, re-verified §8).
 *    ⇒ "the http-port slot" MEANS port 8080. A dev server elsewhere is reached
 *    through an in-sprite RELAY on 8080 (`preview-relay.ts`).
 *  - `stopService` leaves a service in `failed` ("exited with code 143"), not
 *    `stopped` (§4). ⇒ stopped-by-user is OUR row's intent, never the status.
 *  - `port_opened` carries `{port, address: <sprite ip>, pid}`; `address` is
 *    never a per-port public URL (§9). ⇒ classification looks at port + pid
 *    only. `port_closed` is best-effort (§5, §9) ⇒ never a teardown signal.
 *  - A sprite with a running service still hibernates; an inbound URL request
 *    wakes it (§6). ⇒ a relay costs nothing on its own; waking is the proxy's
 *    gate, not this core's concern.
 *
 * FAIL CLOSED, INSTANCE-KEYED (the `egress-lockdown.ts` rule)
 * ----------------------------------------------------------
 * A row describes a Sprite INSTANCE. The planner is handed the instance id
 * the platform reports NOW; a row naming any other instance is a row about a
 * VM that no longer exists and is treated as ABSENT — the replacement VM
 * inherits nothing, and reviving the preview takes a fresh detection on the
 * new instance. No instance id at all ⇒ nothing can be proven about this VM
 * ⇒ refuse. That is what makes an env's preview re-assertable after a rebuild
 * without ever being assumed after one, and a session's preview die with the
 * session by construction.
 *
 * NO PUBLIC EXPOSURE. There is no "public" input, output, plan or status
 * here, and there is no column for one. Adding it is a migration plus a
 * containment ruling, on purpose.
 *
 * DETECTION CHANNEL — READ BEFORE WIRING A CALLER (spike §9)
 * ----------------------------------------------------------
 * `SandboxStream.onPortEvent` (the exec-WS `message` frames the merged seam
 * surfaces) is **TTY-only and superseded**: a dev server started by a plain
 * non-TTY `spawn` emits NOTHING on it (verified twice), so a caller that
 * feeds this core from that channel alone silently detects nothing for every
 * agent-launched server. The REQUIRED channel is the platform's
 * `WSS /v1/sprites/{name}/ports/watch` — a `port_list` snapshot of every
 * bound port on connect, then `port_opened`/`port_closed` for ALL processes
 * in the sprite, TTY or not (verified §9; not wrapped by the SDK, so the
 * effects layer opens it directly). `ListeningPort[]` below is the shape of
 * that snapshot; `SandboxPortEvent` is the shape of its increments, which is
 * why `classifyDetectedDevServer` still takes it.
 */

import type { SandboxPortEvent, SandboxServiceInfo } from '../sandbox-host';
import {
  SPRITE_HTTP_PORT,
  buildPreviewRelaySpec,
  isRelayableTargetPort,
  relayServiceMatches,
  type PreviewRelayRuntime,
  type PreviewRelaySpec,
} from './preview-relay';

// -----------------------------------------------------------------------------
// Inputs
// -----------------------------------------------------------------------------

/** A port currently bound inside the sprite, as a `port_list` snapshot or an accumulated `port_opened` reports it. */
export interface ListeningPort {
  port: number;
  pid?: number;
}

/**
 * WHO the row belongs to — the sprite-holder polymorphism, typed. The rule,
 * stated here because the seam is where it gets lost: **the holder is
 * whoever OWNS the sprite pointer.** A drive env owns its VM. An ephemeral
 * session owns its VM. An ENV-BOUND session (`agent_workspaces.envId` set)
 * owns NOTHING — it borrows the env's VM (`agent_workspaces_env_no_sprite_check`
 * forbids it any sprite column), so a dev server detected inside it is the
 * ENV's preview: keyed to the env, shared by every session in the env,
 * living and dying with the env. Keying it to the session would give one VM
 * two rows under two lifecycles, and the wrong one would win a cascade.
 * Use {@link resolveDevPreviewHolder}; never build this by hand from a row.
 */
export type DevPreviewHolderRef = { kind: 'workspace'; id: string } | { kind: 'env'; id: string };

/**
 * Pure: the holder for a session row. `envId` set ⇒ the env is the holder;
 * otherwise the session is. For a detection made directly against an env
 * (no session in hand) construct `{ kind: 'env', id }` — there is nothing
 * to resolve.
 */
export function resolveDevPreviewHolder(session: { id: string; envId: string | null }): DevPreviewHolderRef {
  return session.envId !== null ? { kind: 'env', id: session.envId } : { kind: 'workspace', id: session.id };
}

/**
 * The `dev_preview_services` row slice the planners read. Kept structural
 * (not the Drizzle type) so this module imports no schema and the proxy task
 * can hand it a plain object.
 */
export interface DevPreviewRow {
  spriteInstanceId: string;
  sandboxId: string;
  targetPort: number;
  relayServiceName: string | null;
  detectedAt: Date;
  stoppedByUserAt: Date | null;
  /**
   * The port a person explicitly agreed to share, or `null` for none. Named
   * by PORT rather than a boolean so approval is per-port by construction: a
   * dev server that moves to another unlisted port is a new decision, not an
   * inherited one. See {@link requiresPreviewApproval}.
   */
  approvedPort: number | null;
  /** When that consent was given; `null` exactly when `approvedPort` is. */
  approvedAt: Date | null;
  /**
   * When a person PICKED this port out of the ports pane, or `null` if the
   * target was found by detection. A pinned target is not a guess for the
   * detector to revise — see the guard in {@link planDevServerService}.
   */
  selectedByUserAt: Date | null;
}

/**
 * The row an effects layer should UPSERT after carrying out a plan. The
 * conflict target is the HOLDER (`dev_preview_services` has a partial unique
 * index per holder column), so a re-create on a rebuilt sprite REPLACES the
 * holder's dead-instance row rather than sitting beside it. Every field is
 * written, including `stoppedByUserAt: null`: a plan that reaches a write
 * has already proven the stop intent does not apply (it was for another
 * instance, or the user cleared it), so the write must clear it too — a
 * merge that skipped the column would resurrect a stop from a dead VM.
 *
 * That clearing is exactly why the write is GUARDED by
 * {@link DevPreviewRowIntent.basedOnStoppedByUserAt}: clearing an intent the
 * planner never saw would silently undo a user's click.
 */
export interface DevPreviewRowIntent {
  holder: DevPreviewHolderRef;
  spriteInstanceId: string;
  sandboxId: string;
  targetPort: number;
  /** `null` iff `targetPort` is 8080 — the schema CHECK in one field. */
  relayServiceName: string | null;
  detectedAt: Date;
  stoppedByUserAt: null;
  /**
   * THE USER-INTENT GUARD (optimistic concurrency, not a value to write).
   *
   * The stop intent this plan was made against — `null` when the planner saw
   * no stop (the usual case, including "no row at all"). The write must land
   * ONLY while the stored intent still equals this; if a user's stop arrived
   * between the read and the write, the row now carries a timestamp, the
   * update is refused, and the intent survives. Without it the detector's
   * `stoppedByUserAt: null` clobbers a click that landed a millisecond
   * earlier, and — since nothing later necessarily re-plans — the user's
   * "off" is lost for good rather than "self-corrected".
   */
  basedOnStoppedByUserAt: Date | null;
}

// -----------------------------------------------------------------------------
// classifyDetectedDevServer
// -----------------------------------------------------------------------------

/**
 * Ports a sandboxed project binds that are NOT an HTTP dev server worth
 * offering: databases, brokers, caches, the node inspector. A port_opened on
 * one of these is a dependency coming up, not the app. Deliberately short and
 * concrete — a wrong entry here hides a real dev server, so only ports whose
 * default owner is unambiguous and never a browser target are listed.
 */
export const NON_HTTP_SERVICE_PORTS: ReadonlySet<number> = new Set([
  22, 25, 53, 1433, 2375, 2376, 3306, 4222, 5432, 5433, 5672, 6379, 9092, 9229, 11211, 27017,
]);

/**
 * Ports dev servers bind BY DEFAULT — vite (5173/5174), next/CRA/express
 * (3000/3001), angular (4200), astro (4321), flask/django (5000/8000),
 * php/webpack (8080/8081), parcel (1234), jupyter (8888). Only a
 * likelihood hint for the UI ("looks like a dev server"), never a filter: an
 * unlisted port is still offered.
 */
export const KNOWN_DEV_SERVER_PORTS: ReadonlySet<number> = new Set([
  1234, 3000, 3001, 4000, 4200, 4321, 5000, 5173, 5174, 8000, 8080, 8081, 8888,
]);

/**
 * Pure: does offering THIS port need a person to say yes first?
 *
 * Starting the relay is the act of exposure — from that moment the port is
 * reachable by everyone the holder's preview is reachable by, which for an
 * env is every accepted member of the drive. Detection is not exposure and
 * is deliberately unchanged: an unlisted port is still detected, still named
 * in the affordance, still explicable. What it does not do any more is
 * publish itself.
 *
 * The line is {@link KNOWN_DEV_SERVER_PORTS}: a port whose default owner is a
 * dev server (vite, next, astro, django…) is what the user asked for by
 * running the tool, and auto-relaying it is the feature working. Anything
 * else — an admin UI on 9000, a debug listener, a colleague's service — is a
 * guess, and a guess that exposes something is one a person makes.
 *
 * This is the ONLY home for the rule. It deliberately does not live in SQL:
 * the port list is TypeScript, and duplicating it into a CHECK would
 * guarantee drift. The security property is structural anyway — the sprite
 * URL routes to 8080 alone, so a row with no relay serves nothing at all.
 */
export function requiresPreviewApproval(port: number): boolean {
  return !KNOWN_DEV_SERVER_PORTS.has(port);
}

/** Pure: has a person approved sharing exactly this port on this row? */
export function isPreviewApproved(row: Pick<DevPreviewRow, 'approvedPort'> | null, port: number): boolean {
  return row !== null && row.approvedPort === port;
}

/** Pure: may this row's target be relayed right now — either it needs no approval, or it has one. */
export function isPreviewShareable(row: Pick<DevPreviewRow, 'approvedPort'> | null, port: number): boolean {
  return !requiresPreviewApproval(port) || isPreviewApproved(row, port);
}

export type DevServerClassification =
  | {
      kind: 'dev-server';
      port: number;
      pid?: number;
      /** `'known-dev-port'` when the port is a common dev-server default; `'unlisted'` otherwise. Data for the UI, not a gate. */
      likelihood: 'known-dev-port' | 'unlisted';
    }
  | {
      kind: 'ignored';
      port: number;
      reason:
        /** `port_closed` — best-effort on the wire (§5, §9); never acted on. */
        | 'port-closed'
        /** Our own relay binding 8080 — not a new dev server. */
        | 'relay-own-listener'
        /** A database/broker/inspector port (see {@link NON_HTTP_SERVICE_PORTS}). */
        | 'non-http-service-port'
        /** Not a TCP port. */
        | 'out-of-range';
    };

export interface ClassifyDetectedDevServerInput {
  event: SandboxPortEvent;
  /**
   * The relay service as the services API reports it now, or null when none
   * is defined. Needed to recognise the relay's OWN bind on 8080: with a pid
   * on both sides they are compared; with either pid missing, a running or
   * starting relay is assumed to be the 8080 listener (a wrong assumption
   * self-corrects — see `describeHttpPortSlot`).
   */
  relay: SandboxServiceInfo | null;
}

function isRelayAlive(relay: SandboxServiceInfo | null): relay is SandboxServiceInfo {
  return relay !== null && (relay.status === 'running' || relay.status === 'starting');
}

/** Pure: is this port notification a dev server worth offering a preview of? */
export function classifyDetectedDevServer({ event, relay }: ClassifyDetectedDevServerInput): DevServerClassification {
  const { port, pid } = event;
  if (event.type === 'port_closed') return { kind: 'ignored', port, reason: 'port-closed' };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { kind: 'ignored', port, reason: 'out-of-range' };
  if (port === SPRITE_HTTP_PORT && isRelayAlive(relay)) {
    const samePid = pid !== undefined && relay.pid !== undefined ? pid === relay.pid : true;
    if (samePid) return { kind: 'ignored', port, reason: 'relay-own-listener' };
  }
  if (NON_HTTP_SERVICE_PORTS.has(port)) return { kind: 'ignored', port, reason: 'non-http-service-port' };
  return {
    kind: 'dev-server',
    port,
    ...(pid !== undefined ? { pid } : {}),
    likelihood: KNOWN_DEV_SERVER_PORTS.has(port) ? 'known-dev-port' : 'unlisted',
  };
}

// -----------------------------------------------------------------------------
// isHttpPortSlotFree
// -----------------------------------------------------------------------------

export interface HttpPortSlotInput {
  /**
   * Ports currently bound in the sprite — the `ports/watch` snapshot the
   * effects layer already holds for a sprite it is attached to. Empty =
   * nothing known to be bound. NEVER fetch this just to answer the question:
   * an exec-based probe wakes a paused sprite, and a wake is billed (spike
   * §6). If the sprite is paused, it has no listeners that matter and the
   * caller should not be planning against it at all.
   */
  listeners: readonly ListeningPort[];
  /** The relay service as reported now, or null when none is defined. */
  relay: SandboxServiceInfo | null;
  /**
   * Where `listeners` came from (see {@link ListenerSource}). Decides whether
   * a listener's PID may contradict a running relay: a `watch` pid can be
   * STALE — the relay restarted under a new pid and the channel never said
   * so (seen in production: the first re-pick rendered a healthy relay as
   * "held by another process (pid <old relay>)") — so only a fresh `probe`
   * pid may. Defaults to `'watch'`.
   */
  listenerSource?: ListenerSource;
}

/**
 * WHERE a listener set came from, because that decides what its SILENCE means.
 *
 *  - `'watch'` — the `ports/watch` channel. **Positive-only evidence.** It
 *    proves what IS bound and NOTHING about what is not: verified against a
 *    real sprite, the channel never reports a Next.js dev server's bind at
 *    all (`ss` shows `*:3000` LISTENING, the channel stays silent, while
 *    python over IPv4 and IPv6, node grandchildren and TTY-session binds are
 *    all reported). Reading absence here as "not listening" told a user their
 *    working preview was down.
 *  - `'probe'` — an authoritative `ss` read of the sprite. Complete, so
 *    absence IS evidence of absence.
 *
 * Defaults to `'watch'` everywhere, which is the conservative reading: a
 * caller that has not said where its data came from does not get to infer a
 * negative from it.
 */
export type ListenerSource = 'watch' | 'probe';

/**
 * Pure: is `port` listening — `true`, `false`, or `null` for "cannot say".
 *
 * The `null` is the whole point. Only a complete source may answer `false`;
 * a `watch` source that lacks the port has not observed it, which is not the
 * same as having observed its absence.
 */
export function isPortListening(
  listeners: readonly ListeningPort[] | null,
  port: number,
  source: ListenerSource = 'watch',
): boolean | null {
  if (listeners === null) return null;
  if (listeners.some((entry) => entry.port === port)) return true;
  return source === 'probe' ? false : null;
}

export type HttpPortSlotHolder = 'none' | 'relay' | 'user-process';

/**
 * Pure: WHO holds 8080 — `'none'` (free), `'relay'` (ours), `'user-process'`
 * (something that is not our relay). {@link isHttpPortSlotFree} is this
 * `=== 'none'`; the UI asks this fuller form so it can say which of the two
 * holders is in the way and how to release it, instead of surfacing a 409.
 *
 * A live relay holds the slot: a `running` relay bound 8080 or it would have
 * failed, so a listener beside it is the relay itself — even when the
 * snapshot's pid disagrees, because a `watch` pid may be stale (the relay
 * restarted; the channel never reported it). Only a fresh `probe` pid that
 * differs from the relay's names a user process. No live relay and a
 * listener is a user process; a live relay with no listener in the snapshot
 * still holds the slot (the snapshot may predate its bind). Misattributing
 * a user process to the relay is self-correcting: the planned relay fails
 * to bind, lands in `failed`, and the next call sees a non-live relay beside
 * a listener.
 */
export function describeHttpPortSlot({ listeners, relay, listenerSource = 'watch' }: HttpPortSlotInput): HttpPortSlotHolder {
  const listener = listeners.find((entry) => entry.port === SPRITE_HTTP_PORT);
  const relayAlive = isRelayAlive(relay);
  if (!listener) return relayAlive ? 'relay' : 'none';
  if (!relayAlive) return 'user-process';
  if (listenerSource !== 'probe') return 'relay';
  const pidsAgree = listener.pid === undefined || relay.pid === undefined || listener.pid === relay.pid;
  return pidsAgree ? 'relay' : 'user-process';
}

/** Pure: is 8080 free — no relay, no user process? The one-slot question, relocated to the port that is actually routed. */
export function isHttpPortSlotFree(input: HttpPortSlotInput): boolean {
  return describeHttpPortSlot(input) === 'none';
}

// -----------------------------------------------------------------------------
// planDevServerService
// -----------------------------------------------------------------------------

export interface PlanDevServerServiceInput {
  /**
   * The Sprite INSTANCE id the platform reports for the holder's sprite RIGHT
   * NOW (`SandboxHandle.spriteInstanceId`). `null` ⇒ refuse: nothing can be
   * proven about a VM whose identity is unknown.
   */
  liveInstanceId: string | null;
  /** The sprite's NAME — recorded on the row for the effects layer's convenience; never identity. */
  sandboxId: string;
  /** The holder's current row, or null. A row for another instance is ignored (stale). */
  row: DevPreviewRow | null;
  /** Who the resulting row belongs to — see {@link DevPreviewHolderRef} for the ownership rule. */
  holder: DevPreviewHolderRef;
  /**
   * A freshly classified dev server on THIS instance, or null when the call is
   * a reconcile with no new detection (then the plan converges the relay on
   * the row's target, if any).
   */
  detected: Extract<DevServerClassification, { kind: 'dev-server' }> | null;
  /** The relay service as reported now (`services.get(PREVIEW_RELAY_SERVICE_NAME)`), or null. */
  relay: SandboxServiceInfo | null;
  /** Ports currently bound in the sprite. */
  listeners: readonly ListeningPort[];
  /**
   * Whether {@link PlanDevServerServiceInput.listeners} is a CURRENT snapshot
   * of the sprite, or merely what the caller happens to hold. Default `true`
   * — the detector plans on a frame it just observed. A caller reconciling
   * without a live `ports/watch` snapshot (a user's resume while the watcher
   * is starting up or reconnecting) passes `false`, and a plan that would
   * START a relay is refused rather than made against an empty listener set:
   * "unknown" must never be read as "8080 is free", the same rule
   * `describeServiceState`'s `listeners: null` obeys. Nothing else changes —
   * a direct 8080 row needs no relay, and stopping never needs the slot.
   */
  listenersKnown?: boolean;
  /**
   * Where {@link PlanDevServerServiceInput.listeners} came from; defaults to
   * `'watch'`. Orthogonal to {@link PlanDevServerServiceInput.listenersKnown}:
   * that one says whether a snapshot is in hand at all, this one says what
   * the snapshot's SILENCE is worth (see {@link ListenerSource}).
   *
   * Deliberately NOT used to gate "is 8080 free". Requiring a probe there
   * would be the stricter rule, but the detector's only source is the watch
   * channel, so it would refuse `slot-unknown` on every reconcile and no
   * relay would ever start on its own — the feature would stop working for
   * every framework in order to be correct about one. The weaker inference
   * stays, and it is self-correcting in the way this module already documents:
   * a relay planned onto an occupied 8080 fails to bind, lands `failed`, and
   * the next call sees a non-live relay beside a listener. A wrong "down" had
   * no such correction, which is why that one is fixed and this one is not.
   */
  listenerSource?: ListenerSource;
  /** Chosen by the effects layer after probing the sprite; `'node'` is the verified default. */
  relayRuntime?: PreviewRelayRuntime;
  now: Date;
}

export type DevServerServicePlan =
  | {
      /**
       * Bring the relay up, then upsert `row`. `via` says how: `'create'` —
       * no relay is defined, `services.create(service)`; `'start'` — the
       * identical relay is defined but not running, `services.start(name)`;
       * `'already-running'` — the identical relay is live and only the row
       * is missing or out of date, touch nothing but the row.
       */
      action: 'start-relay';
      via: 'create' | 'start' | 'already-running';
      service: PreviewRelaySpec;
      row: DevPreviewRowIntent;
    }
  | {
      /** `services.remove(service.name)`, then `services.create(service)`, then upsert `row`. */
      action: 'replace-relay';
      previousTargetPort: number;
      service: PreviewRelaySpec;
      row: DevPreviewRowIntent;
    }
  | {
      /** The user's server is ON 8080: nothing to relay. Remove a leftover relay if asked, then upsert `row`. */
      action: 'record-direct';
      removeRelay: boolean;
      row: DevPreviewRowIntent;
    }
  | {
      /**
       * An UNLISTED port is the target and nobody has agreed to share it.
       * Record the detection — so the UI can name the port and offer the
       * decision — but start NOTHING, and take down a relay left over from a
       * previous target, because that relay is exposure the user did not ask
       * to keep. `row.relayServiceName` is null, which is what makes the
       * sprite serve nothing: the URL routes to 8080 alone.
       */
      action: 'await-approval';
      targetPort: number;
      /** `services.remove(...)` first — a relay for the PREVIOUS target must not outlive it. */
      removeRelay: boolean;
      row: DevPreviewRowIntent;
    }
  | {
      /** The user switched the preview off and the relay is still up: `services.stop(relayServiceName)`. */
      action: 'stop-relay';
      relayServiceName: string;
      /** Whose preview it is — the effects layer re-reads this holder's row to confirm the stop still stands. */
      holder: DevPreviewHolderRef;
      /**
       * The stop intent this plan acts on — the same guard
       * {@link DevPreviewRowIntent.basedOnStoppedByUserAt} applies to writes,
       * for the one effect that is destructive without writing. The effects
       * layer confirms a stop intent still stands before stopping the relay,
       * so a frame planned before a user's RESUME cannot stop the relay after
       * it (the mirror of the clobber the row guard refuses).
       */
      stoppedByUserAt: Date;
    }
  | {
      action: 'none';
      reason:
        | 'already-relaying'
        | 'already-direct'
        | 'user-stopped'
        | 'nothing-detected'
        /**
         * A new UNLISTED port opened while the current KNOWN-dev-port target
         * is still listening — `node --inspect`, a second database, a test
         * UI. Keeping the working preview beats last-detection-wins; the
         * unlisted port is offered again the moment the current target stops
         * listening, or if the user re-points explicitly.
         */
        | 'current-target-preferred'
        | 'user-selected-target';
      /** True when a row for a DIFFERENT instance was present and ignored — the UI's "needs re-creating" signal. */
      staleRowIgnored: boolean;
    }
  | {
      action: 'refuse';
      reason:
        /** No instance id ⇒ no proof ⇒ no plan. */
        | 'instance-unknown'
        /** Something that is not our relay holds 8080 — the honest fallback is "run your server on 8080". */
        | 'http-port-busy'
        /**
         * A relay would have to be started, but no current listener snapshot
         * proves 8080 is free. Refusing costs a retry; planning against an
         * assumed-empty set would start a relay that may fail to bind and
         * leave a state nobody can explain.
         */
        | 'slot-unknown';
      targetPort?: number;
    };

/**
 * Pure: given what was detected and what is live, what should the effects
 * layer do to the relay, and what row should it record?
 */
export function planDevServerService(input: PlanDevServerServiceInput): DevServerServicePlan {
  const { liveInstanceId, sandboxId, holder, detected, relay, listeners, relayRuntime, now } = input;
  if (liveInstanceId === null) return { action: 'refuse', reason: 'instance-unknown' };

  const staleRowIgnored = input.row !== null && input.row.spriteInstanceId !== liveInstanceId;
  const row = staleRowIgnored ? null : input.row;

  if (row?.stoppedByUserAt) {
    if (row.relayServiceName !== null && isRelayAlive(relay)) {
      return { action: 'stop-relay', relayServiceName: row.relayServiceName, holder, stoppedByUserAt: row.stoppedByUserAt };
    }
    return { action: 'none', reason: 'user-stopped', staleRowIgnored };
  }

  // Thrash guard: a fresh UNLISTED port must not displace a target that is
  // still serving — either a KNOWN dev port, or an unlisted one a person has
  // APPROVED. Without the second half, a `node --inspect` bind would knock a
  // working, explicitly-shared preview back into needs-approval and make the
  // user agree to it all over again. Everything else — a known port, or any
  // port once the current target is gone — replaces freely.
  // A port the USER PICKED is not a guess to be revised. The thrash guard
  // below only shields against UNLISTED newcomers, which is right for a
  // detected target — a known dev port appearing is usually the real one. A
  // pinned target is different: the person already answered the question the
  // detector is trying to answer, so ANY newcomer yields to it, whatever its
  // likelihood. It releases on exactly one condition — a PROBE proving the
  // pinned port is gone — because only a probe can establish that, and the
  // channel that would otherwise "prove" it cannot see the very servers
  // people pick by hand.
  if (
    detected !== null && row !== null && detected.port !== row.targetPort
    && row.selectedByUserAt !== null
    && isPortListening(listeners, row.targetPort, input.listenerSource) !== false
  ) {
    return { action: 'none', reason: 'user-selected-target', staleRowIgnored };
  }

  //
  // The presence clause asks "is the current target STILL listening", and it
  // must accept "cannot say" as a yes. It used to require a positive sighting
  // in the listener set, which inverted the guard for exactly the ports it
  // most needed to protect: a target the `ports/watch` channel cannot see
  // (every Next.js dev server) is absent from every snapshot, so the guard
  // never fired and the next unlisted bind — a `node --inspect`, a second
  // worker — silently replaced a preview the user had explicitly chosen.
  // Only a KNOWN-absent target (`false`, which only a probe can produce)
  // releases it.
  if (
    detected !== null && row !== null && detected.port !== row.targetPort
    && detected.likelihood === 'unlisted'
    && isPreviewShareable(row, row.targetPort)
    && isPortListening(listeners, row.targetPort, input.listenerSource) !== false
  ) {
    return { action: 'none', reason: 'current-target-preferred', staleRowIgnored };
  }

  // The target this call converges on: a fresh detection wins; otherwise the
  // row's own target (a reconcile). A stale row contributes nothing here — that
  // is the whole point of ignoring it.
  const targetPort = detected?.port ?? row?.targetPort ?? null;
  const detectedAt = detected ? now : row?.detectedAt ?? now;
  if (targetPort === null) return { action: 'none', reason: 'nothing-detected', staleRowIgnored };

  // ONE row shape, three plans. Only `relayServiceName` differs between them,
  // and the approval and intent guards must be identical in all three — which
  // is exactly the kind of thing three hand-copied literals stop being.
  const rowFor = (relayServiceName: string | null): DevPreviewRowIntent => ({
    holder,
    spriteInstanceId: liveInstanceId,
    sandboxId,
    targetPort,
    relayServiceName,
    detectedAt,
    stoppedByUserAt: null,
    basedOnStoppedByUserAt: row?.stoppedByUserAt ?? null,
  });

  if (targetPort === SPRITE_HTTP_PORT) {
    // The user's own server on 8080 — reachable through the URL as-is. A relay
    // that is still defined is a leftover from an earlier target and must go.
    if (row?.targetPort === SPRITE_HTTP_PORT && relay === null) {
      return { action: 'none', reason: 'already-direct', staleRowIgnored };
    }
    return {
      action: 'record-direct',
      removeRelay: relay !== null,
      row: rowFor(null),
    };
  }

  // CONSENT BEFORE EXPOSURE, and before the slot questions: nothing is being
  // started here, so `http-port-busy` and `slot-unknown` would both be
  // dishonest answers to "why is my preview not up?".
  if (!isPreviewShareable(row, targetPort)) {
    return {
      action: 'await-approval',
      targetPort,
      removeRelay: relay !== null,
      row: rowFor(null),
    };
  }

  if (describeHttpPortSlot({ listeners, relay, listenerSource: input.listenerSource }) === 'user-process') {
    return { action: 'refuse', reason: 'http-port-busy', targetPort };
  }

  const service = buildPreviewRelaySpec({ targetPort, runtime: relayRuntime });
  const rowIntent = rowFor(service.name);

  // A relay that is ALREADY LIVE and already forwards to `targetPort` is
  // decided BEFORE the unknown-slot guard, and must stay that way: neither
  // answer below starts anything, and the question the guard exists to ask —
  // "is 8080 free?" — has an answer that needs no snapshot, because this
  // relay is itself the thing holding it. Ordering these the other way round
  // refused a preview that was already serving, told the user it would start
  // shortly, and (via `describeServiceState`) made a `down` that the planner
  // was supposed to answer `already-relaying` for report a plan of `refuse`.
  if (relay !== null && relayServiceMatches(relay, service) && isRelayAlive(relay)) {
    if (row?.targetPort === targetPort) return { action: 'none', reason: 'already-relaying', staleRowIgnored };
    // Relay is right and live but the row does not say so (a lost write, or
    // a row from a previous target): record it without touching the process.
    return { action: 'start-relay', via: 'already-running', service, row: rowIntent };
  }

  // Everything from here DOES mutate the sprite — a start, a re-point, a
  // create — and the slot can only be called free from a CURRENT snapshot.
  // This refuses only a start planned blind.
  if (input.listenersKnown === false) {
    return { action: 'refuse', reason: 'slot-unknown', targetPort };
  }

  // Matching but not alive: restarting it is a real process start, so it
  // waits for the guard above.
  if (relay !== null && relayServiceMatches(relay, service)) {
    return { action: 'start-relay', via: 'start', service, row: rowIntent };
  }
  if (relay !== null) {
    return { action: 'replace-relay', previousTargetPort: row?.targetPort ?? targetPort, service, row: rowIntent };
  }
  return { action: 'start-relay', via: 'create', service, row: rowIntent };
}

// -----------------------------------------------------------------------------
// describeServiceState
// -----------------------------------------------------------------------------

export interface DescribeServiceStateInput {
  liveInstanceId: string | null;
  row: DevPreviewRow | null;
  relay: SandboxServiceInfo | null;
  /**
   * Ports currently bound, or `null` when no snapshot is in hand — then target
   * liveness is simply not inferred and the relay's own status carries the
   * answer. `null` is the CORRECT input for a paused sprite and for any
   * status render that is not already holding a `ports/watch` snapshot:
   * never open an exec or a probe just to draw a badge, because that wakes
   * the sprite and a wake is billed (spike §6). Rendering must be free.
   */
  listeners: readonly ListeningPort[] | null;
  /**
   * Where {@link DescribeServiceStateInput.listeners} came from. Defaults to
   * `'watch'`, whose silence proves nothing — see {@link ListenerSource}. A
   * target missing from a watch snapshot is therefore rendered as it was
   * RECORDED, not as `down`: this module used to answer "the dev server on
   * port N is not listening any more" about a server that was serving
   * perfectly well, for every framework the channel cannot see.
   */
  listenerSource?: ListenerSource;
  /**
   * Whether the sprite's URL can exist in DNS (`isRoutableSpriteUrlString`).
   * Defaults to true — "nothing to say" — because most readers hold no URL;
   * only the status gather, which reads `urlInfo`, can answer false.
   */
  urlRoutable?: boolean;
}

export type DevPreviewServiceState =
  | { status: 'none'; message: string }
  | { status: 'instance-unknown'; message: string }
  | { status: 'stale'; targetPort: number; message: string }
  | { status: 'stopped'; targetPort: number; stoppedAt: Date; message: string }
  | { status: 'needs-approval'; targetPort: number; message: string }
  | { status: 'starting'; targetPort: number; via: 'relay'; message: string }
  | { status: 'live'; targetPort: number; via: 'relay' | 'direct'; message: string }
  | {
      status: 'down';
      targetPort: number;
      via: 'relay' | 'direct';
      error: string | null;
      message: string;
      /**
       * Whether a RECONCILE (the `resume` user action, or the detector's next
       * frame) can actually repair this. `down` covers two different
       * situations and only one of them is ours to fix:
       *
       *  - `true` — the RELAY is the broken part: crashed, undefined,
       *    pointing at the wrong port, or holding 8080 in front of a direct
       *    row. {@link planDevServerService} answers `start-relay`,
       *    `replace-relay` or `record-direct`, so one reconcile repairs it
       *    and a Restart control is worth offering.
       *  - `false` — the USER'S SERVER is the broken part: the direct row's
       *    8080 server, or a relay's target, stopped listening. The planner
       *    answers `already-direct` / `already-relaying` — nothing to do —
       *    so a reconcile changes nothing and the status comes back down
       *    with the same button. Only starting the dev server again fixes
       *    it, and saying so is more honest than a control that no-ops.
       */
      repairable: boolean;
    }
  | { status: 'blocked'; targetPort: number; message: string };

/** Pure: does this relay service forward to `targetPort`, under either runtime? */
function relayTargets(relay: SandboxServiceInfo, targetPort: number): boolean {
  if (!isRelayableTargetPort(targetPort)) return false;
  return (['node', 'socat'] as const).some((runtime) => relayServiceMatches(relay, buildPreviewRelaySpec({ targetPort, runtime })));
}

/** The copy for a detected-but-unshared port — the ONE place it is worded. */
export function needsApprovalMessage(targetPort: number): string {
  return `A dev server is running on port ${targetPort}. It is not a usual dev-server port, so it is not being shared until you say so.`;
}

/**
 * Shown when the sandbox is live but nothing is watching its ports, so the
 * status on screen may lag.
 *
 * It lives HERE, in the pure core, rather than beside the status model that
 * produces it, because the preview PANE renders it — and importing a value
 * from `dev-preview-status.ts` drags that module's whole dependency graph
 * (the grant signer's `node:crypto`, the store's database client) into the
 * browser bundle. `tsc` is perfectly happy with that; `next build` is not.
 * The core imports nothing but types, which is what makes it safe to reach
 * for from client code.
 */
export const DETECTION_UNAVAILABLE_MESSAGE = 'Dev-server detection is not running right now, so this status may be out of date.';

/** The honest fallback copy for a held slot — the ONE place it is worded. */
export const HTTP_PORT_BUSY_MESSAGE =
  `Port ${SPRITE_HTTP_PORT} is already in use by something that is not the preview relay. Run your dev server on port ${SPRITE_HTTP_PORT} to preview it, or free the port.`;

/** A sandbox whose URL cannot exist in DNS — the ONE place it is worded (the pane, the proxy and the status all say this). */
export const SPRITE_URL_UNRESOLVABLE_MESSAGE =
  'This sandbox was created with a name too long for a preview URL. Create a new environment or session to preview it.';

/** Pure: the row folded with the live service read, as one UI-consumable status. */
export function describeServiceState({ liveInstanceId, row, relay, listeners, listenerSource = 'watch', urlRoutable = true }: DescribeServiceStateInput): DevPreviewServiceState {
  if (row === null) return { status: 'none', message: 'No dev server has been detected in this sandbox yet.' };
  if (liveInstanceId === null) {
    return { status: 'instance-unknown', message: 'The sandbox could not be identified, so its preview state cannot be shown.' };
  }
  if (row.spriteInstanceId !== liveInstanceId) {
    return {
      status: 'stale',
      targetPort: row.targetPort,
      message: `This sandbox was rebuilt since the preview on port ${row.targetPort} was set up. Start the dev server again to re-create it.`,
    };
  }
  if (row.stoppedByUserAt) {
    return {
      status: 'stopped',
      targetPort: row.targetPort,
      stoppedAt: row.stoppedByUserAt,
      message: `Preview of port ${row.targetPort} is switched off.`,
    };
  }

  // Nothing below can help a sandbox whose URL no resolver will answer: the
  // relay may be up and the server serving, and the proxy still cannot reach
  // them. Said here, before the frame is ever opened, and NOT repairable —
  // the fix is a new sandbox, which no button on this pane performs.
  if (!urlRoutable) {
    return {
      status: 'down',
      targetPort: row.targetPort,
      via: row.relayServiceName === null ? 'direct' : 'relay',
      error: 'sprite-url-unresolvable',
      repairable: false,
      message: SPRITE_URL_UNRESOLVABLE_MESSAGE,
    };
  }

  const targetListening = isPortListening(listeners, row.targetPort, listenerSource);

  const holder = describeHttpPortSlot({ listeners: listeners ?? [], relay, listenerSource });

  // Detected, recorded, and serving NOTHING — no relay for a non-8080 target
  // means the sprite URL (which routes to 8080 alone) reaches nothing. Three
  // reasons land here and they read very differently to a user.
  if (row.relayServiceName === null && row.targetPort !== SPRITE_HTTP_PORT) {
    // SHAREABLE, not APPROVED. A row can reach this branch with a perfectly
    // ordinary dev-server port — a stopped preview records that its relay is
    // no longer running, and the resume that follows clears the stop before
    // the relay is re-created. Asking `isPreviewApproved` there would demand
    // consent for port 5173, which needs none, and offer a Share button for a
    // port that was never withheld.
    if (!isPreviewShareable(row, row.targetPort)) {
      return { status: 'needs-approval', targetPort: row.targetPort, message: needsApprovalMessage(row.targetPort) };
    }
    // The slot is TAKEN: the relay was planned and refused, and no future
    // reconcile gets further while the port is held. Asked BEFORE the case
    // below, and only when a snapshot actually proves it (`listeners: null`
    // leaves the slot unknown, which is not evidence of a problem).
    if (holder === 'user-process') return { status: 'blocked', targetPort: row.targetPort, message: HTTP_PORT_BUSY_MESSAGE };
    // DOWN, not "starting…". A relay is normally created in the same call that
    // clears the stop or records the consent, so this shape means that create
    // did NOT happen — the slot could not be proven free, the holder's lock
    // was contended, the call failed. Nothing necessarily converges it: the
    // sweep only handles rows that are still switched OFF, and the detector
    // needs a port frame a dev server that is already listening will not
    // emit. Saying "starting" would promise an arrival that never comes and
    // would take away the one control that fixes it — `down` is what puts the
    // Restart button back.
    return {
      status: 'down',
      targetPort: row.targetPort,
      via: 'relay',
      error: null,
      // Ours to fix, and the reason this branch says `down` at all: the row
      // names no relay, so a reconcile plans `start-relay` via `create`.
      repairable: true,
      message: `The preview relay for port ${row.targetPort} is not defined on this sandbox.`,
    };
  }

  if (row.relayServiceName === null) {
    // Direct: the user's server on 8080 is the whole path, so the slot holder
    // IS the status — the same question the relay branch asks, read the other
    // way round: a user process is what we want here, a live relay is a
    // leftover that has taken the port from under the user's server.
    if (holder === 'relay') {
      // Ours to fix: the reconcile plans `record-direct` with `removeRelay`.
      return { status: 'down', targetPort: row.targetPort, via: 'direct', error: null, repairable: true, message: `A leftover preview relay still holds port ${SPRITE_HTTP_PORT}; it will be removed on the next reconcile.` };
    }
    if (targetListening === false) {
      // NOT ours to fix: the planner answers `already-direct`. Only the user
      // starting their server on 8080 again brings this back.
      return { status: 'down', targetPort: row.targetPort, via: 'direct', error: null, repairable: false, message: `Nothing is listening on port ${SPRITE_HTTP_PORT} any more.` };
    }
    return { status: 'live', targetPort: row.targetPort, via: 'direct', message: `Serving port ${SPRITE_HTTP_PORT} directly.` };
  }

  if (holder === 'user-process') return { status: 'blocked', targetPort: row.targetPort, message: HTTP_PORT_BUSY_MESSAGE };

  if (relay === null || relay.name !== row.relayServiceName) {
    // Ours to fix: the reconcile creates (or replaces) the relay.
    return { status: 'down', targetPort: row.targetPort, via: 'relay', error: null, repairable: true, message: `The preview relay for port ${row.targetPort} is not defined on this sandbox.` };
  }
  // The relay has ONE name, so the name proves nothing about WHERE it forwards.
  // A replace whose service call landed but whose row write did not leaves the
  // service on the new port and the row on the old one; reporting the row's
  // port as live would then describe traffic that is going somewhere else.
  // The runtime is not on the row, so either runtime's spec for this port is
  // accepted; anything else is a relay for another port.
  if (!relayTargets(relay, row.targetPort)) {
    // Ours to fix: the reconcile plans `replace-relay`.
    return { status: 'down', targetPort: row.targetPort, via: 'relay', error: null, repairable: true, message: `The preview relay on this sandbox forwards to a different port than ${row.targetPort}; it will be re-pointed on the next reconcile.` };
  }
  if (relay.status === 'starting') {
    return { status: 'starting', targetPort: row.targetPort, via: 'relay', message: `Starting the preview relay for port ${row.targetPort}…` };
  }
  if (relay.status === 'running') {
    if (targetListening === false) {
      // NOT ours to fix: the relay is up and correct, so the planner answers
      // `already-relaying`. The user's dev server has to come back first.
      return { status: 'down', targetPort: row.targetPort, via: 'relay', error: null, repairable: false, message: `The dev server on port ${row.targetPort} is not listening any more.` };
    }
    return { status: 'live', targetPort: row.targetPort, via: 'relay', message: `Relaying port ${SPRITE_HTTP_PORT} to your dev server on port ${row.targetPort}.` };
  }
  // failed / stopped / stopping / unknown — with no stopped-by-user intent this is a crash, whatever the platform calls it (§4).
  // Ours to fix: a defined, correctly-pointed relay that is not running is
  // exactly what `start-relay` via `'start'` restarts.
  return {
    status: 'down',
    targetPort: row.targetPort,
    via: 'relay',
    error: relay.error ?? null,
    repairable: true,
    message: `The preview relay for port ${row.targetPort} is not running${relay.error ? ` (${relay.error})` : ''}.`,
  };
}

