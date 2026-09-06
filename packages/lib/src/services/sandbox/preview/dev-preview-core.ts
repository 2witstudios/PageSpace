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
   * self-corrects — see `httpPortSlotHolder`).
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
}

export type HttpPortSlotHolder = 'none' | 'relay' | 'user-process';

/**
 * Who holds 8080. A listener whose pid matches a live relay — or whose pid is
 * unknown while a relay is live — is the relay; any other listener is a user
 * process. A live relay with no listener in the snapshot still holds the slot
 * (the snapshot may predate its bind). Misattributing a user process to the
 * relay is self-correcting: the planned relay fails to bind, lands in
 * `failed`, and the next call sees a non-live relay beside a listener.
 */
function httpPortSlotHolder({ listeners, relay }: HttpPortSlotInput): HttpPortSlotHolder {
  const listener = listeners.find((entry) => entry.port === SPRITE_HTTP_PORT);
  const relayAlive = isRelayAlive(relay);
  if (!listener) return relayAlive ? 'relay' : 'none';
  if (!relayAlive) return 'user-process';
  const pidsAgree = listener.pid === undefined || relay.pid === undefined || listener.pid === relay.pid;
  return pidsAgree ? 'relay' : 'user-process';
}

/** Pure: is 8080 free — no relay, no user process? The one-slot question, relocated to the port that is actually routed. */
export function isHttpPortSlotFree(input: HttpPortSlotInput): boolean {
  return httpPortSlotHolder(input) === 'none';
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
      /** The user switched the preview off and the relay is still up: `services.stop(relayServiceName)`. */
      action: 'stop-relay';
      relayServiceName: string;
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
        | 'current-target-preferred';
      /** True when a row for a DIFFERENT instance was present and ignored — the UI's "needs re-creating" signal. */
      staleRowIgnored: boolean;
    }
  | {
      action: 'refuse';
      reason:
        /** No instance id ⇒ no proof ⇒ no plan. */
        | 'instance-unknown'
        /** Something that is not our relay holds 8080 — the honest fallback is "run your server on 8080". */
        | 'http-port-busy';
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
      return { action: 'stop-relay', relayServiceName: row.relayServiceName };
    }
    return { action: 'none', reason: 'user-stopped', staleRowIgnored };
  }

  // Thrash guard: a fresh UNLISTED port must not displace a KNOWN dev-port
  // target that is still serving. Everything else — a known port, or any port
  // once the current target is gone — replaces freely.
  if (
    detected !== null && row !== null && detected.port !== row.targetPort
    && detected.likelihood === 'unlisted' && KNOWN_DEV_SERVER_PORTS.has(row.targetPort)
    && listeners.some((entry) => entry.port === row.targetPort)
  ) {
    return { action: 'none', reason: 'current-target-preferred', staleRowIgnored };
  }

  // The target this call converges on: a fresh detection wins; otherwise the
  // row's own target (a reconcile). A stale row contributes nothing here — that
  // is the whole point of ignoring it.
  const targetPort = detected?.port ?? row?.targetPort ?? null;
  const detectedAt = detected ? now : row?.detectedAt ?? now;
  if (targetPort === null) return { action: 'none', reason: 'nothing-detected', staleRowIgnored };

  if (targetPort === SPRITE_HTTP_PORT) {
    // The user's own server on 8080 — reachable through the URL as-is. A relay
    // that is still defined is a leftover from an earlier target and must go.
    if (row?.targetPort === SPRITE_HTTP_PORT && relay === null) {
      return { action: 'none', reason: 'already-direct', staleRowIgnored };
    }
    return {
      action: 'record-direct',
      removeRelay: relay !== null,
      row: { holder, spriteInstanceId: liveInstanceId, sandboxId, targetPort, relayServiceName: null, detectedAt, stoppedByUserAt: null },
    };
  }

  if (httpPortSlotHolder({ listeners, relay }) === 'user-process') {
    return { action: 'refuse', reason: 'http-port-busy', targetPort };
  }

  const service = buildPreviewRelaySpec({ targetPort, runtime: relayRuntime });
  const rowIntent: DevPreviewRowIntent = {
    holder,
    spriteInstanceId: liveInstanceId,
    sandboxId,
    targetPort,
    relayServiceName: service.name,
    detectedAt,
    stoppedByUserAt: null,
  };

  if (relay !== null && relayServiceMatches(relay, service)) {
    if (isRelayAlive(relay)) {
      if (row?.targetPort === targetPort) return { action: 'none', reason: 'already-relaying', staleRowIgnored };
      // Relay is right and live but the row does not say so (a lost write, or
      // a row from a previous target): record it without touching the process.
      return { action: 'start-relay', via: 'already-running', service, row: rowIntent };
    }
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
}

export type DevPreviewServiceState =
  | { status: 'none'; message: string }
  | { status: 'instance-unknown'; message: string }
  | { status: 'stale'; targetPort: number; message: string }
  | { status: 'stopped'; targetPort: number; stoppedAt: Date; message: string }
  | { status: 'starting'; targetPort: number; via: 'relay'; message: string }
  | { status: 'live'; targetPort: number; via: 'relay' | 'direct'; message: string }
  | { status: 'down'; targetPort: number; via: 'relay' | 'direct'; error: string | null; message: string }
  | { status: 'blocked'; targetPort: number; message: string };

/** Pure: does this relay service forward to `targetPort`, under either runtime? */
function relayTargets(relay: SandboxServiceInfo, targetPort: number): boolean {
  if (!isRelayableTargetPort(targetPort)) return false;
  return (['node', 'socat'] as const).some((runtime) => relayServiceMatches(relay, buildPreviewRelaySpec({ targetPort, runtime })));
}

/** The honest fallback copy for a held slot — the ONE place it is worded. */
export const HTTP_PORT_BUSY_MESSAGE =
  `Port ${SPRITE_HTTP_PORT} is already in use by something that is not the preview relay. Run your dev server on port ${SPRITE_HTTP_PORT} to preview it, or free the port.`;

/** Pure: the row folded with the live service read, as one UI-consumable status. */
export function describeServiceState({ liveInstanceId, row, relay, listeners }: DescribeServiceStateInput): DevPreviewServiceState {
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

  const targetListening = listeners === null ? null : listeners.some((entry) => entry.port === row.targetPort);

  const holder = httpPortSlotHolder({ listeners: listeners ?? [], relay });

  if (row.relayServiceName === null) {
    // Direct: the user's server on 8080 is the whole path, so the slot holder
    // IS the status — the same question the relay branch asks, read the other
    // way round: a user process is what we want here, a live relay is a
    // leftover that has taken the port from under the user's server.
    if (holder === 'relay') {
      return { status: 'down', targetPort: row.targetPort, via: 'direct', error: null, message: `A leftover preview relay still holds port ${SPRITE_HTTP_PORT}; it will be removed on the next reconcile.` };
    }
    if (targetListening === false) {
      return { status: 'down', targetPort: row.targetPort, via: 'direct', error: null, message: `Nothing is listening on port ${SPRITE_HTTP_PORT} any more.` };
    }
    return { status: 'live', targetPort: row.targetPort, via: 'direct', message: `Serving port ${SPRITE_HTTP_PORT} directly.` };
  }

  if (holder === 'user-process') return { status: 'blocked', targetPort: row.targetPort, message: HTTP_PORT_BUSY_MESSAGE };

  if (relay === null || relay.name !== row.relayServiceName) {
    return { status: 'down', targetPort: row.targetPort, via: 'relay', error: null, message: `The preview relay for port ${row.targetPort} is not defined on this sandbox.` };
  }
  // The relay has ONE name, so the name proves nothing about WHERE it forwards.
  // A replace whose service call landed but whose row write did not leaves the
  // service on the new port and the row on the old one; reporting the row's
  // port as live would then describe traffic that is going somewhere else.
  // The runtime is not on the row, so either runtime's spec for this port is
  // accepted; anything else is a relay for another port.
  if (!relayTargets(relay, row.targetPort)) {
    return { status: 'down', targetPort: row.targetPort, via: 'relay', error: null, message: `The preview relay on this sandbox forwards to a different port than ${row.targetPort}; it will be re-pointed on the next reconcile.` };
  }
  if (relay.status === 'starting') {
    return { status: 'starting', targetPort: row.targetPort, via: 'relay', message: `Starting the preview relay for port ${row.targetPort}…` };
  }
  if (relay.status === 'running') {
    if (targetListening === false) {
      return { status: 'down', targetPort: row.targetPort, via: 'relay', error: null, message: `The dev server on port ${row.targetPort} is not listening any more.` };
    }
    return { status: 'live', targetPort: row.targetPort, via: 'relay', message: `Relaying port ${SPRITE_HTTP_PORT} to your dev server on port ${row.targetPort}.` };
  }
  // failed / stopped / stopping / unknown — with no stopped-by-user intent this is a crash, whatever the platform calls it (§4).
  return {
    status: 'down',
    targetPort: row.targetPort,
    via: 'relay',
    error: relay.error ?? null,
    message: `The preview relay for port ${row.targetPort} is not running${relay.error ? ` (${relay.error})` : ''}.`,
  };
}

