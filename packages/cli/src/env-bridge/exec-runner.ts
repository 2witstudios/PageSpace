/**
 * The exec runner — the ONLY file in the daemon that touches
 * `node:child_process` (a grep test pins this). It runs a `NormalizedRequest`
 * that `decideExecution` returned as `allow`, and nothing else: the type is
 * the contract, and the runtime asserts back it up so a caller cannot hand it
 * a raw frame by accident.
 *
 * What the child sees is exactly the normalized request — the confined cwd
 * and the scrubbed env — plus a PATH this runner builds itself (the lifted
 * desktop resolver's well-known dirs; PATH is hard-denied on the wire so it
 * can only come from here). Even though `scrubEnv` already refused loader
 * hooks, the runner re-asserts none survived (`isHardDeniedEnvVar`): defence
 * in depth on the one line that spawns.
 *
 * Limits are enforced HERE, locally, with the owner's clamped values:
 * `timeoutMs` SIGKILLs the child's whole PROCESS GROUP (`detached: true`
 * gives it one; `process.kill(-pid)` reaches every descendant, so a timed-out
 * `sh -c 'sleep 30'` leaves no orphan), `maxBytes` caps stdout+stderr
 * together and flags `truncated` while still draining the pipes so the child
 * is never blocked on a full pipe. `killAll` is what Ctrl-C calls.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import type { Readable } from 'node:stream';
import type { NormalizedRequest } from './lib-core.js';
import { isHardDeniedEnvVar } from './lib-core.js';
import { enhancedPath, resolveCommand, type CommandResolverDeps } from './command-resolver.js';

/** The slice of `ChildProcess` the runner needs; a test fake is an EventEmitter with two PassThroughs. */
export interface SpawnedChild {
  pid?: number | undefined;
  stdout: Readable | null;
  stderr: Readable | null;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

export interface SpawnOptionsUsed {
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly detached: true;
  readonly stdio: readonly ['ignore', 'pipe', 'pipe'];
  readonly windowsHide: true;
}

export type SpawnLike = (command: string, args: readonly string[], options: SpawnOptionsUsed) => SpawnedChild;

export interface ExecRunnerDeps {
  readonly spawn: SpawnLike;
  /** Signal a whole process group. */
  readonly killGroup: (pid: number, signal: NodeJS.Signals) => void;
  readonly resolver: CommandResolverDeps;
}

export interface ExecOutcome {
  readonly exitCode: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly truncated: boolean;
  readonly timedOut: boolean;
}

export interface ExecRunner {
  run(request: NormalizedRequest): Promise<ExecOutcome>;
  /** Ctrl-C / disconnect: SIGKILL every live process group. */
  /** SIGKILL every live process group (Ctrl-C, and a verified STOP from the server). @returns how many were signalled. */
  killAll(): number;
  liveCount(): number;
}

const EXIT_CANNOT_EXECUTE = 126;
const EXIT_NOT_FOUND = 127;

function exitCodeOf(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (signal !== null) return 128 + (osConstants.signals[signal] ?? 0);
  return -1;
}

/** Bounded, shared budget across both streams; drains past the cap so the child never blocks. */
function collect(stream: Readable | null, budget: { remaining: number; truncated: boolean }): Promise<Buffer> {
  if (stream === null) return Promise.resolve(Buffer.alloc(0));
  const chunks: Buffer[] = [];
  return new Promise((resolve) => {
    stream.on('data', (chunk: Buffer | string) => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      if (budget.remaining <= 0) {
        budget.truncated = true;
        return;
      }
      if (bytes.length > budget.remaining) {
        chunks.push(bytes.subarray(0, budget.remaining));
        budget.remaining = 0;
        budget.truncated = true;
        return;
      }
      chunks.push(bytes);
      budget.remaining -= bytes.length;
    });
    const done = () => resolve(Buffer.concat(chunks));
    stream.on('end', done);
    stream.on('close', done);
    stream.on('error', done);
  });
}

export function createExecRunner(deps: ExecRunnerDeps): ExecRunner {
  const live = new Set<number>();

  const kill = (pid: number) => {
    try {
      deps.killGroup(pid, 'SIGKILL');
    } catch {
      // Already gone (ESRCH) — nothing to do.
    }
  };

  return {
    liveCount: () => live.size,
    killAll() {
      let killed = 0;
      for (const pid of live) {
        kill(pid);
        killed += 1;
      }
      return killed;
    },
    async run(request) {
      if (request.op !== 'exec' || typeof request.cmd !== 'string' || request.cmd.length === 0) {
        throw new Error('exec-runner: refusing a request that is not an executable exec');
      }
      const hooks = Object.keys(request.env).filter(isHardDeniedEnvVar);
      if (hooks.length > 0) throw new Error(`exec-runner: refusing to spawn with hard-denied env (${hooks.join(', ')})`);

      const command = resolveCommand(request.cmd, deps.resolver);
      if (command === null) {
        return { exitCode: EXIT_NOT_FOUND, stdout: Buffer.alloc(0), stderr: Buffer.from(`command not found: ${request.cmd}\n`), truncated: false, timedOut: false };
      }

      const env: Record<string, string> = { ...request.env, PATH: enhancedPath(deps.resolver) };
      const child = deps.spawn(command, request.args ?? [], { cwd: request.cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      const pid = child.pid;
      if (pid !== undefined) live.add(pid);

      const budget = { remaining: request.maxBytes, truncated: false };
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        if (pid !== undefined) kill(pid);
      }, request.timeoutMs);

      const stdout = collect(child.stdout, budget);
      const stderr = collect(child.stderr, budget);
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error: Error | null }>((resolve) => {
        child.on('error', (error) => {
          // A failed spawn never runs anything; its pipes will never end on their own.
          child.stdout?.destroy();
          child.stderr?.destroy();
          resolve({ code: null, signal: null, error });
        });
        child.on('close', (code, signal) => resolve({ code, signal, error: null }));
      });

      try {
        const result = await closed;
        const [out, err] = await Promise.all([stdout, stderr]);
        if (result.error !== null) {
          return { exitCode: EXIT_CANNOT_EXECUTE, stdout: out, stderr: Buffer.concat([err, Buffer.from(`${result.error.message}\n`)]), truncated: budget.truncated, timedOut };
        }
        return { exitCode: exitCodeOf(result.code, result.signal), stdout: out, stderr: err, truncated: budget.truncated, timedOut };
      } finally {
        clearTimeout(timer);
        if (pid !== undefined) live.delete(pid);
      }
    },
  };
}

/** The production runner: real `spawn`, real process-group kill, real filesystem for PATH resolution. */
export function createNodeExecRunner(resolver: CommandResolverDeps): ExecRunner {
  return createExecRunner({
    spawn: nodeSpawn as unknown as SpawnLike,
    killGroup: (pid, signal) => process.kill(-pid, signal),
    resolver,
  });
}
