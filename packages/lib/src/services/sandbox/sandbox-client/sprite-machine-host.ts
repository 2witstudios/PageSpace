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
import type { SpriteCommandLike, SpritesSdk } from './sprites';

function toBuffer(chunk: Buffer | string): Buffer {
  return typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
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

    async stream(args) {
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
      return wrapSpriteStream(command);
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
