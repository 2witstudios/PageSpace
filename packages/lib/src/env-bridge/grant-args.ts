/**
 * The `argsHash` projection — what, EXACTLY, a grant's `argsHash` covers for
 * each op (Codex C7: "argsHash projection undefined per op").
 *
 * Invariant 3 binds a grant to the frame that carries it by hashing the
 * request's args on both sides: the server signer when it issues the grant,
 * the daemon gate (`verifyGrant`) before anything runs. That only works if
 * both sides hash the SAME bytes — and "the frame's args" is not a definition:
 * a signer that hashed `{cmd, args}` while the gate hashed `{cmd, args, env}`
 * would refuse every grant, and a signer that hashed everything while the
 * gate skipped `env` would leave `LD_PRELOAD` free for a man-in-the-middle to
 * add. So this module is the single definition, for both sides:
 *
 *   - **Fixed field set per op.** Every projection has every field, every
 *     time. An optional the frame omitted is `null` (scalars), `[]` (lists)
 *     or `{}` (env) — never a missing key, never `undefined` — so "absent"
 *     hashes identically on both sides and distinctly from "empty".
 *   - **Fixed order.** `canonicalizeArgs` sorts keys, so order does not change
 *     the bytes; it is still fixed (and tested) so the projection reads the
 *     same in the signer, the gate, and the audit log.
 *   - **No leakage.** The envelope (`type`, `grant`, `sig`) and anything a
 *     hostile frame smuggles beside the declared fields are never projected.
 *   - **Content is signed for writes.** `grant_fs_write` projects each file's
 *     `contentB64` and `mode`, not just its path: a grant to write one thing
 *     must not authorize writing another to the same path.
 *
 * `executionRequestForFrame` derives the `ExecutionRequest` that
 * `decideExecution` evaluates FROM the projection, so the daemon decides on
 * exactly the fields that were signed and nothing beside them.
 *
 * Pure: no I/O, no clock, no crypto.
 */
import type { Frame } from './frame-codec';
import type { GrantOp } from './grant';
import type { ExecutionRequest } from './decide-execution';

/** The frames that carry a grant: the server → machine requests. */
export type GrantFrame = Extract<Frame, { type: 'grant_exec' | 'grant_fs_read' | 'grant_fs_write' | 'grant_pty_open' }>;
export type GrantFrameType = GrantFrame['type'];

export const GRANT_FRAME_TYPES: readonly GrantFrameType[] = ['grant_exec', 'grant_fs_read', 'grant_fs_write', 'grant_pty_open'];

export interface ExecGrantArgs {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly cwd: string | null;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number | null;
  readonly maxBytes: number | null;
}

export interface FsReadGrantArgs {
  readonly paths: readonly string[];
}

export interface FsWriteGrantFile {
  readonly path: string;
  readonly contentB64: string;
  readonly mode: number | null;
}

export interface FsWriteGrantArgs {
  readonly files: readonly FsWriteGrantFile[];
}

export interface PtyOpenGrantArgs {
  readonly cols: number;
  readonly rows: number;
  readonly cwd: string | null;
  readonly command: string | null;
  readonly args: readonly string[];
}

export type GrantArgs = ExecGrantArgs | FsReadGrantArgs | FsWriteGrantArgs | PtyOpenGrantArgs;

/**
 * The `{op, args}` pair a grant is bound to — `verifyGrant` hashes `args` and
 * compares `op`. Correlated per op so a signer cannot pair an exec projection
 * with an `fs_write` grant by accident.
 */
export type GrantRequest =
  | { readonly op: 'exec'; readonly args: ExecGrantArgs }
  | { readonly op: 'fs_read'; readonly args: FsReadGrantArgs }
  | { readonly op: 'fs_write'; readonly args: FsWriteGrantArgs }
  | { readonly op: 'pty_open'; readonly args: PtyOpenGrantArgs };

/** Copy a string map field by field: a fresh object, only string values, never the frame's own reference. */
function copyEnv(env: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (env === undefined) return out;
  for (const key of Object.keys(env)) {
    const value = env[key];
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/**
 * The exact args object both sides hash for this frame.
 * @returns a fresh projection with the op's fixed field set in its fixed order.
 */
export function grantArgsForFrame(frame: GrantFrame): GrantArgs {
  return grantRequestForFrame(frame).args;
}

/** The op a grant must name to authorize this frame. */
export function grantOpForFrame(frame: GrantFrame): GrantOp {
  return grantRequestForFrame(frame).op;
}

/**
 * The `{op, args}` the grant on this frame must be bound to. This is the
 * function the signer calls before signing and the gate calls before
 * verifying; there is no other definition.
 */
export function grantRequestForFrame(frame: GrantFrame): GrantRequest {
  switch (frame.type) {
    case 'grant_exec':
      return {
        op: 'exec',
        args: {
          cmd: frame.cmd,
          args: [...(frame.args ?? [])],
          cwd: frame.cwd ?? null,
          env: copyEnv(frame.env),
          timeoutMs: frame.timeoutMs ?? null,
          maxBytes: frame.maxBytes ?? null,
        },
      };
    case 'grant_fs_read':
      return { op: 'fs_read', args: { paths: [...frame.paths] } };
    case 'grant_fs_write':
      return {
        op: 'fs_write',
        args: {
          files: frame.files.map((file) => ({ path: file.path, contentB64: file.contentB64, mode: file.mode ?? null })),
        },
      };
    case 'grant_pty_open':
      return {
        op: 'pty_open',
        args: {
          cols: frame.cols,
          rows: frame.rows,
          cwd: frame.cwd ?? null,
          command: frame.command ?? null,
          args: [...(frame.args ?? [])],
        },
      };
  }
}

/**
 * The request `decideExecution` evaluates for this frame, derived from the
 * signed projection (never from the raw frame). `null` projections become
 * absent fields because `ExecutionRequest` models "not given" as `undefined`
 * and its shape gate refuses a `null` cwd as malformed.
 */
export function executionRequestForFrame(frame: GrantFrame): ExecutionRequest {
  const request = grantRequestForFrame(frame);
  switch (request.op) {
    case 'exec': {
      const { cmd, args, cwd, env, timeoutMs, maxBytes } = request.args;
      return {
        op: 'exec',
        cmd,
        args,
        ...(cwd !== null && { cwd }),
        env,
        ...(timeoutMs !== null && { timeoutMs }),
        ...(maxBytes !== null && { maxBytes }),
      };
    }
    case 'fs_read':
      return { op: 'fs_read', paths: request.args.paths };
    case 'fs_write':
      return { op: 'fs_write', paths: request.args.files.map((file) => file.path) };
    case 'pty_open': {
      const { command, args, cwd } = request.args;
      return {
        op: 'pty_open',
        ...(command !== null && { cmd: command }),
        args,
        ...(cwd !== null && { cwd }),
      };
    }
  }
}
