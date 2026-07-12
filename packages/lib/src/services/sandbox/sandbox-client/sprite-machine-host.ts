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
  type MachineHandle,
  type MachineHost,
  type MachineStream,
  type MachineStreamSessionInfo,
} from '../machine-host';
import type { ExecSandboxClient, ExecutableSandbox } from './types';
import {
  withWakeRetry,
  asPreOpenDrop,
  spawnWithSelfHealingCwd,
  type SpriteCommandLike,
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
    const timer = setTimeout(() => settle(() => reject(new MachineStreamOpenTimeoutError(timeoutMs))), timeoutMs);

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
     * that FIRST connection before it ever opens, and this path had no retry at
     * all: `killAgentTerminal` attaches and immediately SIGKILLs,
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
        await awaitStreamOpen(command, streamOpenTimeoutMs);
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
    async provision({ name, options, appliedEgressToken }) {
      const exec = await client.getOrCreate({ name, options, appliedEgressToken });
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
