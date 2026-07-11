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

import type {
  MachineHandle,
  MachineHost,
  MachineStream,
  MachineStreamSessionInfo,
} from '../machine-host';
import type { ExecSandboxClient, ExecutableSandbox } from './types';
import { withWakeRetry, type SpriteCommandLike, type SpritesSdk } from './sprites';

function toBuffer(chunk: Buffer | string): Buffer {
  return typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
}

/**
 * How long to wait for a freshly-opened stream to report that its WebSocket
 * actually opened, before handing it back anyway.
 */
const STREAM_OPEN_TIMEOUT_MS = 10_000;

/**
 * Resolve once the stream's WebSocket has genuinely OPENED; reject if it dropped
 * before opening.
 *
 * The SDK emits `spawn` only after `cmd.start()` resolves — i.e. after the socket
 * is up — and emits `error` (never `spawn`) on a failed attach, so the two events
 * are the authoritative open/fail signals. `exit` also settles: a command that has
 * already finished has nothing left to wait for.
 *
 * The wait is CAPPED, and the cap resolves OPTIMISTICALLY rather than rejecting.
 * That keeps this strictly better than the previous behavior (which handed the
 * stream back immediately, without waiting for anything): a command that reports
 * neither outcome degrades to exactly what callers used to get, so this can never
 * hang a kill that used to succeed.
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
    const timer = setTimeout(() => settle(resolve), timeoutMs);
    command.on('spawn', () => settle(resolve));
    command.on('exit', () => settle(resolve));
    command.on('error', (error) => settle(() => reject(error)));
  });
}

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

function wrapSpriteHandle({ sdk, exec }: { sdk: SpritesSdk; exec: ExecutableSandbox }): MachineHandle {
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
      return withWakeRetry(async () => {
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
        // Don't hand back a stream whose socket never opened — a SIGKILL through
        // it would go nowhere. A pre-open drop rejects here and withWakeRetry
        // re-opens; anything else propagates on the first occurrence.
        await awaitStreamOpen(command, STREAM_OPEN_TIMEOUT_MS);
        return wrapSpriteStream(command);
      });
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
}: {
  sdk: SpritesSdk;
  client: ExecSandboxClient;
}): MachineHost {
  return {
    // `substrate.size` is intentionally unused here — see the file header:
    // Sprite has one resource tier, driven entirely by `options.caps`.
    async provision({ name, options }) {
      const exec = await client.getOrCreate({ name, options });
      return wrapSpriteHandle({ sdk, exec });
    },

    async attach({ machineId }) {
      const exec = await client.get({ sandboxId: machineId });
      if (!exec) return null;
      return wrapSpriteHandle({ sdk, exec });
    },

    async kill({ machineId }) {
      await client.stop({ sandboxId: machineId });
    },
  };
}
