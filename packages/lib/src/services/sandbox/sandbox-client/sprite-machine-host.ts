/**
 * Sprite `MachineHost` — re-expresses the EXISTING Sprite driver behind the
 * `MachineHost` seam (see `../machine-host.ts`). Pure composition, no new
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
  MachineStreamOpenTimeoutError,
  MachineStreamSessionGoneError,
  type MachineHandle,
  type MachineHost,
  type MachineStream,
  type MachineStreamSessionInfo,
} from '../machine-host';
import type { ExecSandboxClient, ExecutableSandbox } from './types';
import { withWakeRetry, isSpriteNotFoundError, type SpriteCommandLike, type SpritesSdk } from './sprites';

function toBuffer(chunk: Buffer | string): Buffer {
  return typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
}

/**
 * Wall-clock cap on waiting for a stream to report that it opened.
 *
 * Deliberately LONGER than the SDK's own 10s `waitForSessionInfo` timeout
 * (websocket.js), which is the real failure signal for an attach to a dangling
 * session. A shorter cap here would fire first on every such attach and mask the
 * SDK's specific error behind a generic timeout — and, since the two outcomes
 * demand opposite responses from the kill path (drop the row vs keep it), that
 * misclassification is not cosmetic.
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
 * failure, so those are the authoritative signals. `exit` also settles: a
 * command that already finished has nothing left to wait for.
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
    const timer = setTimeout(() => settle(() => reject(new MachineStreamOpenTimeoutError(timeoutMs))), timeoutMs);
    command.on('spawn', () => settle(resolve));
    command.on('exit', () => settle(resolve));
    command.on('error', (error) => settle(() => reject(error)));
  });
}

// NOTE: an abandoned attempt's WebSocket cannot be torn down through the SDK's
// public API — `SpriteCommand` exposes only start/wait/kill/signal/resize, and
// `kill` is `signal`, which no-ops unless the socket is already OPEN; the
// underlying `WSCommand.close()` is private. A socket that failed with "closed
// before open" is already closed by definition, so the residue is limited to the
// pathological case where the transport reports nothing at all and we abandon it
// at the wall-clock cap. Bounded by kill frequency, and not fixable here without
// an SDK change.

function wrapSpriteStream(command: SpriteCommandLike): MachineStream {
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
      // never construct a MachineStream, but forward stderr too so a caller
      // that opens one anyway never silently loses output.
      command.stderr.on('data', (chunk) => listener(toBuffer(chunk)));
    },
    onExit(listener) {
      command.on('exit', listener);
    },
    onError(listener) {
      command.on('error', listener);
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
}): MachineHandle {
  return {
    machineId: exec.sandboxId,
    exec: (args) => exec.runCommand(args),
    writeFiles: (files) => exec.writeFiles(files),
    readFile: (args) => exec.readFileToBuffer(args),

    /**
     * Open a PTY stream, surviving the cold-start wake drop.
     *
     * Opening a stream (attachSession/createSession) is itself an exec, so it IS
     * the wake for a hibernated Sprite — there is no wake API
     * (docs.sprites.dev/concepts/lifecycle). But Fly's wake-on-request can drop
     * that FIRST connection before it opens ("closed before open"), and this path
     * had no retry at all: `killAgentTerminal` attaches and immediately SIGKILLs,
     * so a dropped wake silently failed the kill and left the row behind. The
     * exec path (`withWakeRetry`) and the realtime PTY (`openPtyShell`'s bounded
     * reconnect) both already absorb that drop; this is the third caller, and now
     * it does too — on the same bounded schedule, re-opening a fresh connection
     * per attempt.
     */
    async stream(args) {
      const open = async (): Promise<MachineStream> => {
        const sprite = await sdk.getSprite(exec.sandboxId);
        const command =
          args.sessionId !== undefined
            ? sprite.attachSession(args.sessionId, { cwd: args.cwd, env: args.env, cols: args.cols, rows: args.rows })
            : sprite.createSession(args.command ?? 'bash', args.args ?? [], {
                tty: true,
                cwd: args.cwd,
                env: args.env,
                cols: args.cols,
                rows: args.rows,
              });
        try {
          await awaitStreamOpen(command, streamOpenTimeoutMs);
        } catch (error) {
          // Translate the ONE failure that carries positive evidence — the exec
          // endpoint answering 404/410 — into the typed "session is gone" signal.
          // The SDK reports a rejected upgrade as `WebSocket error: Unexpected
          // server response: <status>`, so the status is recoverable from the
          // message. Everything else (a 429, a 5xx mid-deploy, a socket hang-up,
          // a timeout) stays exactly as it is: an UNKNOWN, on which no caller may
          // tear down a session's bookkeeping.
          if (args.sessionId !== undefined && isSpriteNotFoundError(error)) {
            throw new MachineStreamSessionGoneError(args.sessionId, error);
          }
          throw error;
        }
        return wrapSpriteStream(command);
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

    async listStreams(): Promise<MachineStreamSessionInfo[]> {
      const sprite = await sdk.getSprite(exec.sandboxId);
      const sessions = await sprite.listSessions();
      return sessions.filter((s) => s.tty).map((s) => ({ id: s.id, command: s.command, isActive: s.isActive }));
    },
  };
}

/**
 * Build the Sprite `MachineHost`. `client` is the existing `ExecSandboxClient`
 * (`createSpritesSandboxClient`) — its provisioning, egress lockdown, cold-start
 * retry, and error classification are reused unchanged. `sdk` is the same
 * `SpritesSdk` used to build `client`, needed here only to reach the raw
 * Sprite instance for the PTY methods `ExecSandboxClient` does not expose.
 */
export function createSpriteMachineHost({
  sdk,
  client,
  streamOpenTimeoutMs = STREAM_OPEN_TIMEOUT_MS,
}: {
  sdk: SpritesSdk;
  client: ExecSandboxClient;
  /** Injectable so the open-wait is testable without fake timers (which would also stall provisioning). Production uses the default. */
  streamOpenTimeoutMs?: number;
}): MachineHost {
  return {
    // `substrate.size` is intentionally unused here — see the file header:
    // Sprite has one resource tier, driven entirely by `options.caps`.
    async provision({ name, options }) {
      const exec = await client.getOrCreate({ name, options });
      return wrapSpriteHandle({ sdk, exec, streamOpenTimeoutMs });
    },

    async attach({ machineId }) {
      const exec = await client.get({ sandboxId: machineId });
      if (!exec) return null;
      return wrapSpriteHandle({ sdk, exec, streamOpenTimeoutMs });
    },

    async kill({ machineId }) {
      await client.stop({ sandboxId: machineId });
    },
  };
}
