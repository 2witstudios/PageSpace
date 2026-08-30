/**
 * Sprite `SandboxHost` — re-expresses the EXISTING Sprite driver behind the
 * `SandboxHost` seam (see `../sandbox-host.ts`). Pure composition, no new
 * provisioning/exec/egress/retry logic: lifecycle + exec + files are the
 * already-hardened `ExecSandboxClient` (`./sprites.ts`, unchanged); the PTY
 * stream is the same `createSession`/`attachSession`/`listSessions` capability
 * `SpriteInstanceLike` already declares (today driven directly by
 * `apps/realtime/src/terminal/sprites-shell.ts`, which this file does not
 * touch or replace).
 *
 * Every Sprite machine is substrate `{ kind: 'sprite' }`. `size` is accepted
 * for interface completeness but Sprite has no differentiated resource tier
 * today — 'beefy' is a placeholder for a future GPU backend (e.g. Modal), so a
 * Sprite machine behaves identically regardless of the declared size; caps
 * come entirely from the caller-supplied `options.caps`, exactly as before
 * this seam existed.
 */

import {
  SandboxSpriteReplacedError,
  SandboxStreamOpenTimeoutError,
  type SandboxHandle,
  type SandboxHost,
  type SandboxPortEvent,
  type SandboxServiceInfo,
  type SandboxServiceStatus,
  type SandboxServicesApi,
  type SandboxStream,
  type SandboxStreamSessionInfo,
  type SandboxUrlAuth,
  type SandboxUrlInfo,
} from '../sandbox-host';
import type { ExecSandboxClient, ExecutableSandbox } from './types';
import {
  withWakeRetry,
  asPreOpenDrop,
  drainServiceLogStream,
  isSpriteGoneStatus,
  readPortNotification,
  spawnWithSelfHealingCwd,
  SERVICE_LOG_MONITOR_WINDOW,
  type SpriteCommandLike,
  type SpriteInstanceLike,
  type SpriteServiceRecordLike,
  type SpritesSdk,
} from './sprites';
import { SANDBOX_ROOT } from '../sandbox-paths';

function toBuffer(chunk: Buffer | string): Buffer {
  return typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
}

/**
 * Wall-clock cap on waiting for a stream to report that it opened.
 *
 * Deliberately LONGER than the SDK's own 10s `waitForSessionInfo` timeout
 * (websocket.js), so that when an attach to a dangling session fails, the SDK's
 * own error arrives first and we reject with THAT rather than pre-empting it with
 * a generic timeout of our own. The cap is the backstop for a transport that
 * reports nothing at all, not the expected failure path.
 */
const STREAM_OPEN_TIMEOUT_MS = 20_000;

/**
 * Resolve once the stream's WebSocket has genuinely OPENED; reject if it dropped,
 * failed, or never reported either way.
 *
 * This wait is load-bearing, not a nicety. `SpriteCommand.kill()` sends a signal
 * over the socket and SILENTLY NO-OPS when the socket is not open (websocket.js
 * `signal()` early-returns unless `readyState === OPEN`). So handing back a
 * stream whose socket never opened gives the caller a kill that goes nowhere
 * while reporting success — for `killAgentTerminal` that means the row is
 * dropped and a live, billable agent process is orphaned. We therefore never
 * resolve optimistically: no confirmed open, no stream.
 *
 * The SDK emits `spawn` only after `start()` resolves (socket up, and for an
 * attach, `session_info` received) and emits `error` — never `spawn` — on a
 * failure, so `spawn` is the authoritative open signal.
 */
function awaitStreamOpen(command: SpriteCommandLike, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => settle(() => reject(new SandboxStreamOpenTimeoutError(timeoutMs))), timeoutMs);

    // 'spawn' is the ONLY confirmation of an open. Deliberately NOT 'exit': for an
    // attach, the SDK SYNTHESIZES `exit` from the socket closing (websocket.js's
    // handleClose maps a tty close to an exit code) — but a `detachable` tmux
    // session OUTLIVES its client socket, so a synthesized exit is not evidence
    // the process died. Accepting it as a successful open would hand the caller a
    // dead stream whose SIGKILL silently no-ops, and `killAgentTerminal` would
    // then drop the row of a PTY that is still running.
    command.on('spawn', () => settle(resolve));

    // We only listen during the pre-open window, so an error seen here is pre-open
    // BY CONSTRUCTION — there is no need (and, given the opaque undici message, no
    // way) to infer that from its text. Marking it is what lets the bounded wake
    // retry fire.
    command.on('error', (error) => settle(() => reject(asPreOpenDrop(error))));
  });
}

// NOTE: an abandoned attempt's WebSocket cannot be torn down through the SDK's
// public API — `SpriteCommand` exposes only start/wait/kill/signal/resize, and
// `kill` is `signal`, which no-ops unless the socket is already OPEN; the
// underlying `WSCommand.close()` is private. A socket that already reported a
// close is closed by definition, so the residue is limited to the pathological
// case where the transport reports nothing at all and we abandon it at the
// wall-clock cap. Bounded by kill frequency, and not fixable here without an SDK
// change.

/** The Sprite wire statuses this seam recognizes. Anything else — a future
 *  SDK/runtime addition — normalizes to 'unknown' rather than leaking an
 *  unvalidated string through the provider-neutral type. */
const KNOWN_SERVICE_STATUSES: readonly SandboxServiceStatus[] = [
  'stopped',
  'starting',
  'running',
  'stopping',
  'failed',
];

/**
 * Pure: map a Sprite service record onto the provider-neutral shape.
 * A record with no `state` at all (never observed live, but the SDK types it
 * optional) is 'unknown', not a guess.
 */
export function normalizeSpriteService(record: SpriteServiceRecordLike): SandboxServiceInfo {
  const status = record.state?.status;
  return {
    name: record.name,
    command: record.cmd,
    args: record.args,
    ...(record.httpPort !== undefined ? { httpPort: record.httpPort } : {}),
    status: status !== undefined && (KNOWN_SERVICE_STATUSES as readonly string[]).includes(status)
      ? status
      : 'unknown',
    ...(record.state?.pid !== undefined ? { pid: record.state.pid } : {}),
    ...(record.state?.error !== undefined ? { error: record.state.error } : {}),
  };
}

/**
 * Pure: map the wire's URL auth string onto the closed union. The wire returns
 * a superset of the SDK types (`private_access` rides alongside `auth` —
 * verified), so only the two modes the platform verifies map through; anything
 * else — including an absent value — is 'unknown', which consumers must treat
 * as NOT proven private (see `SandboxUrlAuth`).
 */
export function normalizeSpriteUrlAuth(auth: string | undefined): SandboxUrlAuth {
  return auth === 'public' || auth === 'sprite' ? auth : 'unknown';
}

function wrapSpriteServices(getSprite: () => Promise<SpriteInstanceLike>): SandboxServicesApi {
  return {
    async create({ name, command, args, httpPort }) {
      const sprite = await getSprite();
      // The PUT auto-starts the service and hands back its startup log stream;
      // resolving before that stream completes would report success for an
      // operation still in flight (and leak the response body's reader).
      await drainServiceLogStream(
        await sprite.createService(
          name,
          { cmd: command, ...(args !== undefined ? { args } : {}), ...(httpPort !== undefined ? { httpPort } : {}) },
          SERVICE_LOG_MONITOR_WINDOW,
        ),
      );
    },
    async list() {
      const sprite = await getSprite();
      return (await sprite.listServices()).map(normalizeSpriteService);
    },
    async get(name) {
      // Derived from list rather than the SDK's getService: the SDK rejects a
      // miss with an untyped `Error('Service not found: …')` that message-match
      // classification would have to fish out — an absent row from the listing
      // is the same answer without the fragility.
      const sprite = await getSprite();
      const record = (await sprite.listServices()).find((s) => s.name === name);
      return record !== undefined ? normalizeSpriteService(record) : null;
    },
    async start(name) {
      const sprite = await getSprite();
      await drainServiceLogStream(await sprite.startService(name, SERVICE_LOG_MONITOR_WINDOW));
    },
    async stop(name) {
      const sprite = await getSprite();
      await drainServiceLogStream(await sprite.stopService(name));
    },
    async remove(name) {
      const sprite = await getSprite();
      await sprite.deleteService(name);
    },
  };
}

/**
 * Buffers port_opened/port_closed notifications on `command`'s message
 * channel from the moment THIS is called, replaying anything buffered to
 * the first `subscribe` call and forwarding live afterward.
 *
 * Necessary because a caller cannot subscribe to `onPortEvent` before
 * `stream()` resolves and hands back the `SandboxStream` — but a fast dev
 * server can bind its port and emit `port_opened` inside that very window
 * (spawn -> stream open confirmed -> caller receives the handle -> caller
 * calls `onPortEvent`). Unlike terminal scrollback (which the server
 * replays on attach — see `readSessionInfoId`'s doc), a missed port event
 * is gone for good: the spike found no server-side replay for it (docs/
 * spikes/2026-08-dev-preview-sprite-services-spike.md §5). So the listener
 * for the underlying `message` event is attached unconditionally, as early
 * as the command handle exists — not deferred to the first `onPortEvent`
 * call, which is what `EventEmitter`'s no-replay semantics would otherwise
 * silently drop. (Flagged by Codex review on PR #2520.)
 */
// Cap on the pre-subscribe buffer in `bufferPortEvents` — see its doc. A
// stream nobody ever calls `onPortEvent` on (true of every caller today —
// this seam is dark) must not accumulate port events for its entire
// lifetime; drop the oldest once this many are queued. Generous for any
// realistic single-process port lifecycle (repeated crash-restart loops
// included) while still bounding memory on an hours-long PTY session.
const PORT_EVENT_BUFFER_CAP = 64;

function bufferPortEvents(command: SpriteCommandLike): {
  subscribe(listener: (event: SandboxPortEvent) => void): void;
} {
  const buffered: SandboxPortEvent[] = [];
  // A LIST, not a single slot: `onData`/`onExit`/`onError` above all attach a
  // fresh listener to the underlying EventEmitter on every call, so two
  // subscribers coexist (fan-out) rather than the second silently replacing
  // the first. `onPortEvent` must match that shape — a caller has no way to
  // know a second subscribe would otherwise orphan the first with no error.
  const listeners: Array<(event: SandboxPortEvent) => void> = [];
  command.on('message', (message) => {
    // Same `message` event `readSessionInfoId` reads — the SDK re-emits every
    // TEXT control frame there. Port frames only actually arrive on TTY
    // sessions (server-side filter — see `SpritePortNotification`), which is
    // what every SandboxStream is. Non-port frames parse to undefined and
    // are dropped; nothing here classifies or acts, per the seam contract.
    const event = readPortNotification(message);
    if (event === undefined) return;
    if (listeners.length > 0) {
      for (const l of listeners) l(event);
    } else {
      buffered.push(event);
      if (buffered.length > PORT_EVENT_BUFFER_CAP) buffered.shift();
    }
  });
  return {
    subscribe(l) {
      // Replay what arrived before ANY subscriber existed — only the FIRST
      // subscribe drains and clears the buffer; once at least one listener
      // is attached, every event forwards live to all of them and the
      // buffer never accumulates again. A subscriber joining after that
      // point gets live events only, same as joining any other pub/sub late.
      for (const event of buffered) l(event);
      if (listeners.length === 0) buffered.length = 0;
      listeners.push(l);
    },
  };
}

function wrapSpriteStream(
  command: SpriteCommandLike,
  portEvents: { subscribe(listener: (event: SandboxPortEvent) => void): void },
): SandboxStream {
  return {
    write(data) {
      if (!command.stdin) {
        throw new Error('Machine stream is not interactive (spawned without a PTY)');
      }
      command.stdin.write(data);
    },
    resize(cols, rows) {
      command.resize?.(cols, rows);
    },
    onData(listener) {
      command.stdout.on('data', (chunk) => listener(toBuffer(chunk)));
      // A PTY combines stdout/stderr onto one stream; batch (non-tty) callers
      // never construct a SandboxStream, but forward stderr too so a caller
      // that opens one anyway never silently loses output.
      command.stderr.on('data', (chunk) => listener(toBuffer(chunk)));
    },
    onExit(listener) {
      command.on('exit', listener);
    },
    onError(listener) {
      command.on('error', listener);
    },
    onPortEvent(listener) {
      portEvents.subscribe(listener);
    },
    kill(signal) {
      command.kill(signal);
    },
  };
}

function wrapSpriteHandle({
  sdk,
  exec,
  streamOpenTimeoutMs,
}: {
  sdk: SpritesSdk;
  exec: ExecutableSandbox;
  streamOpenTimeoutMs: number;
}): SandboxHandle {
  return {
    sandboxId: exec.sandboxId,
    spriteInstanceId: exec.spriteInstanceId ?? null,
    egressPolicyToken: exec.egressPolicyToken,
    exec: (args) => exec.runCommand(args),
    writeFiles: (files) => exec.writeFiles(files),
    readFile: (args) => exec.readFileToBuffer(args),
    createCheckpoint: (comment) => exec.createCheckpoint(comment),

    /**
     * Open a PTY stream, surviving the cold-start wake drop.
     *
     * Opening a stream (attachSession/createSession) is itself an exec, so it IS
     * the wake for a hibernated Sprite — there is no wake API
     * (docs.sprites.dev/concepts/lifecycle). But Fly's wake-on-request can drop
     * that FIRST connection before it ever opens, so any caller of this method
     * needs the same absorption the exec path (`withWakeRetry`) and the realtime
     * PTY (`openPtyShell`'s bounded reconnect) already have — bounded retry,
     * re-opening a fresh connection per attempt.
     *
     * NOTE (Sprites 2-3, the kill-endpoint leaf): `killAgentTerminal` used to be
     * this method's reason for existing (`stream()` + `SandboxStream.kill()`,
     * with this retry protecting the wake) — it now calls
     * `SandboxHandle.killSession` directly (a REST call to the documented kill
     * endpoint, idempotent on its own, with its own retry — see
     * `killSpriteSession` in `sprites.ts`), bypassing `stream()` entirely. This
     * method is kept as the general PTY-stream primitive `SandboxHandle`
     * promises callers (see file header); it currently has no production caller.
     */
    async stream(args) {
      const open = async (): Promise<SandboxStream> => {
        const sprite = await sdk.getSprite(exec.sandboxId);
        const command =
          args.sessionId !== undefined
            ? sprite.attachSession(args.sessionId, { cwd: args.cwd, env: args.env, cols: args.cols, rows: args.rows })
            : sprite.createSession(
                // Self-healing cwd, for the same reason the batch `runCommand`
                // path uses one: the server chdirs into `cwd` before spawning, so
                // a deleted SANDBOX_ROOT (a sandbox command can `rm -rf` it) would
                // fail the session open outright. Recreate + enter it, then exec
                // the real command — cwd/command/args stay positional data args,
                // never interpolated into the script.
                ...spawnWithSelfHealingCwd({
                  command: args.command ?? 'bash',
                  args: args.args ?? [],
                  cwd: args.cwd ?? SANDBOX_ROOT,
                }),
                {
                  tty: true,
                  env: args.env,
                  cols: args.cols,
                  rows: args.rows,
                },
              );
        // Start buffering port events IMMEDIATELY — before awaiting the open
        // confirmation, let alone before the caller can call `onPortEvent`.
        // See `bufferPortEvents`'s doc for why this can't wait.
        const portEvents = bufferPortEvents(command);
        await awaitStreamOpen(command, streamOpenTimeoutMs);
        return wrapSpriteStream(command, portEvents);
      };

      // Retry ONLY the attach. Re-opening an attach is idempotent — it targets a
      // session that already exists — whereas `createSession` starts a DETACHABLE
      // session that outlives the client, so re-running it after a drop we only
      // observed client-side could mint a second orphaned PTY. A pre-open drop is
      // provably a socket that never opened, but not provably a request the
      // server never received, and that distinction only costs us on the
      // side-effecting branch. (No caller opens a fresh session through this seam
      // today; the realtime PTY drives `createSession` directly and does its own
      // bounded reconnect.)
      return args.sessionId !== undefined ? withWakeRetry(open) : open();
    },

    async listStreams(): Promise<SandboxStreamSessionInfo[]> {
      const sprite = await sdk.getSprite(exec.sandboxId);
      const sessions = await sprite.listSessions();
      // Exclude only sessions the SDK explicitly reports as NON-tty (plain batch
      // execs are not terminals). `tty` is unreliable — see `SpriteSessionInfo`:
      // the published 0.0.1 SDK drops the field from listSessions entirely, so a
      // truthy filter would hide EVERY stream after a routine SDK bump. Treat an
      // absent `tty` as unknown and keep the session: an extra row in the stream
      // list is a cosmetic flaw; an empty one looks like the machine has no
      // terminals at all.
      return sessions
        .filter((s) => s.tty !== false)
        .map((s) => ({ id: s.id, command: s.command, isActive: s.isActive }));
    },

    async killSession(sessionId: string): Promise<void> {
      const sprite = await sdk.getSprite(exec.sandboxId);
      await sprite.killSession(sessionId);
    },

    // Dev-preview seam (dark until the proxy/decision-core tasks consume it):
    // the service lifecycle + URL info verified live by
    // docs/spikes/2026-08-dev-preview-sprite-services-spike.md.
    //
    // Same getSprite-PER-CALL pattern as stream/listStreams/killSession
    // above — no local caching or wake-retry wrapping here, matching those
    // pre-existing methods exactly (this is not a new gap this seam
    // introduces). `apps/realtime` wraps its `sdk` in
    // `createSpriteHandleCache` (sprites.ts) before reaching this file, which
    // collapses same-connect reads to one round trip; `apps/web`'s
    // `sprites-client.ts` does NOT, so a caller chaining several of these
    // calls there pays one control-plane read per call. Fixing that is
    // production SDK-factory wiring, out of scope for this dark seam —
    // whoever wires the first real caller should either request the cache be
    // added to the web factory or accept the N+1 cost. Wake-retry is the same
    // story: a hibernated sprite may need `withWakeRetry` around these calls
    // once a real caller exists, but the correct retry POSTURE depends on
    // that caller (see the container doc's note on the code-exec gate for
    // wake-through-the-proxy) — copying `withWakeRetry` here blind would be a
    // guess, not a verified behavior.
    services: wrapSpriteServices(() => sdk.getSprite(exec.sandboxId)),

    async urlInfo(): Promise<SandboxUrlInfo> {
      const sprite = await sdk.getSprite(exec.sandboxId);
      return {
        url: sprite.url ?? null,
        auth: normalizeSpriteUrlAuth(sprite.urlSettings?.auth),
      };
    },

    async setUrlAuth(auth): Promise<void> {
      const sprite = await sdk.getSprite(exec.sandboxId);
      await sprite.updateURLSettings({ auth });
    },
  };
}

/**
 * Build the Sprite `SandboxHost`. `client` is the existing `ExecSandboxClient`
 * (`createSpritesSandboxClient`) — its provisioning, egress lockdown, cold-start
 * retry, and error classification are reused unchanged. `sdk` is the same
 * `SpritesSdk` used to build `client`, needed here only to reach the raw
 * Sprite instance for the PTY methods `ExecSandboxClient` does not expose.
 */
export function createSpriteSandboxHost({
  sdk,
  client,
  streamOpenTimeoutMs = STREAM_OPEN_TIMEOUT_MS,
}: {
  sdk: SpritesSdk;
  client: ExecSandboxClient;
  /** Injectable so the open-wait is testable without fake timers (which would also stall provisioning). Production uses the default. */
  streamOpenTimeoutMs?: number;
}): SandboxHost {
  return {
    // `substrate.size` is intentionally unused here — see the file header:
    // Sprite has one resource tier, driven entirely by `options.caps`.
    async provision({ name, options, appliedEgressToken }) {
      const exec = await client.getOrCreate({ name, options, appliedEgressToken });
      return wrapSpriteHandle({ sdk, exec, streamOpenTimeoutMs });
    },

    async attach({ sandboxId }) {
      const exec = await client.get({ sandboxId });
      if (!exec) return null;
      return wrapSpriteHandle({ sdk, exec, streamOpenTimeoutMs });
    },

    /**
     * Idempotent by contract: a Sprite the control plane says is ALREADY GONE is
     * a successful kill, not a failure — mirroring `attach` above, which maps a
     * not-found error to a null handle rather than throwing.
     *
     * Every caller depends on this. `teardownOneMachine` derives
     * `spriteTornDown` from whether this throws, so a not-found error used to
     * report a live orphaned Sprite for one that had in fact already been
     * destroyed; `killBranch` and the orphan reconciler
     * (`machine-orphan-reconcile.ts`) would likewise refuse to release a
     * tracking row whose Sprite no longer exists, leaving a permanently
     * un-clearable candidate.
     *
     * Gated on `isSpriteGoneStatus` — an authoritative 404/410 — NOT the looser
     * `isSpriteNotFoundError` the read path uses. That one also accepts
     * `ENOTFOUND` (a DNS failure) and message heuristics, which are safe when a
     * false positive merely costs a redundant provision, but here a false
     * positive is destructive: callers treat "did not throw" as proof the Sprite
     * is dead and release its ONLY pointer. A transient DNS blip would then
     * strand every Sprite in the batch, billing forever. Anything that leaves the
     * Sprite's fate unknown (auth, rate limit, 5xx, socket, DNS) throws, which
     * keeps the row — and the retry — intact.
     */
    async kill({ sandboxId, expectedInstanceId }) {
      try {
        // Identity guard. The kill is NAME-keyed (`deleteSprite(name)`) and a name
        // is REUSED across re-creates, so without this we would happily destroy a
        // REPLACEMENT Sprite — a live VM someone re-provisioned under the same
        // session key after the one we meant to kill was already gone. Read who
        // actually lives at this name first; if it is not our target, our target
        // is already dead and there is nothing to do. (A replace between this read
        // and the delete below is a residual TOCTOU, but the DB-side CAS is keyed
        // on the same instance id, so a replacement still cannot have its pointer
        // dropped.)
        if (expectedInstanceId != null) {
          const current = await sdk.getSprite(sandboxId);
          if (current.id != null && current.id !== expectedInstanceId) {
            // A DIFFERENT VM holds this name now, so the one we were told to kill
            // is already gone. THROW rather than return success: "success" means
            // "confirmed destroyed", and every caller acts on it by releasing the
            // Sprite's last pointer (deleting the tracking row and its rescued
            // outbox entry). If the caller's instance id were stale — the row not
            // yet updated after a re-provision — that release would drop the only
            // pointer to the LIVE VM standing here, billing forever. Refusing keeps
            // the pointer and surfaces the staleness as a retry, which is the
            // safe way to be wrong.
            throw new SandboxSpriteReplacedError(sandboxId, expectedInstanceId, current.id);
          }
        }
        await client.stop({ sandboxId });
      } catch (error) {
        if (isSpriteGoneStatus(error)) return;
        throw error;
      }
    },
  };
}
