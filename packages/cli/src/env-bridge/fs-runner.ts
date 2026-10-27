/**
 * The fs runner — reads and writes ONLY the confined real paths a
 * `NormalizedRequest` carries (`confinePath` output, never a wire path), and
 * proves, on the OPEN OBJECT, that what it holds is what confinement approved
 * (Codex C9, and its P1 follow-up on PR #2546: an ancestor swap).
 *
 * WHY PATHNAMES ARE NOT ENOUGH. `confinePath` resolved a pathname. Between
 * that and the `open`, any local process may retarget a component of it —
 * the final one (a symlink swapped in) or an ANCESTOR (a directory renamed
 * away and a symlink, or a bind mount, put in its place). `O_NOFOLLOW`
 * covers only the final component, and a later `lstat(path)` walks the same
 * replaced ancestor, so it agrees with the handle and proves nothing.
 *
 * WHAT THIS MODULE DOES (Node has no `openat`, so ancestry is verified by
 * handle identity rather than by opening relative to a directory fd):
 *
 *  1. The root the path lies under is resolved (`realpath`) and every
 *     directory from that root down to the file's parent is opened with
 *     `O_DIRECTORY | O_NOFOLLOW`; the opened handle's `dev`/`ino` must equal
 *     an `lstat` of that name, which must be a directory and not a link. A
 *     symlinked or non-directory component is refused during the walk.
 *  2. The target is opened with `O_NOFOLLOW` and NEVER `O_TRUNC`, then
 *     re-checked on the handle: a regular file whose `dev`/`ino` equals a
 *     post-open `lstat`.
 *  3. Every ancestor is `lstat`ed AGAIN after the open and compared with the
 *     identities recorded in step 1: an ancestor replaced at any point between
 *     the walk and the open is detected here (`ancestor_replaced`) and the
 *     handle is closed unused.
 *  4. On Linux the final handle is resolved through `/proc/self/fd/<fd>` and
 *     its real path must lie under the root (`escaped_root`).
 *  5. Only now does a write `ftruncate` the VERIFIED handle and write to it.
 *     Because `O_TRUNC` is never used, a handle that fails verification has
 *     destroyed nothing.
 *
 * RESIDUAL, stated precisely. Steps 1–3 detect a swap because a replacement
 * has a different inode. What they cannot detect is an ancestor swapped out
 * AND swapped back so that step 3 sees the original again while the open in
 * step 2 followed the replacement (two swaps inside the window between the
 * walk and the re-walk). On Linux step 4 closes that too: the fd's own real
 * path is asked from the kernel. On macOS the residual stands; the
 * remaining cost to an attacker is winning a double race against a window
 * of a few syscalls, and the payoff is bounded by the policy's `ask` /
 * allowlist gate on who may request at all. A swap AFTER the final open
 * changes nothing: every later byte moves through the verified fd.
 *
 * `fs_read` serves exactly ONE path (the `fs_read_result` frame carries one
 * content) and refuses, from `fstat` size BEFORE reading, a file that could
 * not fit the frame limit once base64-encoded (`too_large`). Content crosses
 * this boundary as base64; nothing here interprets it. On Windows
 * `O_NOFOLLOW` / `O_DIRECTORY` do not exist and the walk degrades to the
 * identity checks alone.
 */
import { promises as fsp, constants as fsConstants } from 'node:fs';
import { dirname, posix } from 'node:path';
import type { NormalizedRequest } from './lib-core.js';

export interface HandleStats {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly size: number | bigint;
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface PathStats extends HandleStats {
  isSymbolicLink(): boolean;
}

export interface OpenHandle {
  readonly fd: number;
  stat(): Promise<HandleStats>;
  readFile(): Promise<Buffer>;
  writeFile(data: Buffer): Promise<void>;
  truncate(length: number): Promise<void>;
  /** Apply `mode` to the open object (CWE-732: `open` sets mode only on CREATE, so an existing file keeps its old permissions otherwise). */
  chmod(mode: number): Promise<void>;
  close(): Promise<void>;
}

export interface FsPrimitives {
  readonly platform: NodeJS.Platform | string;
  open(path: string, flags: number, mode?: number): Promise<OpenHandle>;
  lstat(path: string): Promise<PathStats>;
  realpath(path: string): Promise<string>;
}

export type ReadOutcome =
  | { readonly kind: 'read'; readonly found: boolean; readonly contentB64?: string }
  | { readonly kind: 'unsupported'; readonly reason: 'multi_path_read' }
  | { readonly kind: 'too_large'; readonly size: number; readonly maxContentBytes: number }
  | { readonly kind: 'error'; readonly error: string };
export type WriteOutcome = { readonly kind: 'write'; readonly ok: boolean; readonly error?: string };

export interface FsWriteContent {
  readonly contentB64: string;
  readonly mode: number | null;
}

export interface FsReadOptions {
  /** The policy roots; the path must lie under one of them (resolved). */
  readonly roots: readonly string[];
  /** Largest raw file that fits the frame limit once encoded (`fsReadContentCeiling`). */
  readonly maxContentBytes: number;
}

export interface FsWriteOptions {
  readonly roots: readonly string[];
}

export interface FsRunner {
  read(request: NormalizedRequest, options: FsReadOptions): Promise<ReadOutcome>;
  write(request: NormalizedRequest, files: readonly FsWriteContent[], options: FsWriteOptions): Promise<WriteOutcome>;
}

const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const DIRECTORY = fsConstants.O_DIRECTORY ?? 0;
const DEFAULT_WRITE_MODE = 0o644;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const codeOf = (error: unknown): string | undefined => (typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined);

function isWithin(target: string, root: string): boolean {
  return target === root || target.startsWith(root.endsWith('/') ? root : `${root}/`);
}

class VerificationError extends Error {
  constructor(readonly reason: string, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = 'VerificationError';
  }
}

interface DirIdentity {
  readonly dir: string;
  readonly dev: number | bigint;
  readonly ino: number | bigint;
}

/** Open `dir` as a directory, no link following, and prove the handle is the entry `lstat` named. */
async function verifyDirectory(dir: string, primitives: FsPrimitives): Promise<DirIdentity> {
  const named = await primitives.lstat(dir);
  if (named.isSymbolicLink() || !named.isDirectory()) throw new VerificationError('ancestor_not_directory', dir);
  const handle = await primitives.open(dir, fsConstants.O_RDONLY | DIRECTORY | NOFOLLOW);
  try {
    const held = await handle.stat();
    if (!held.isDirectory()) throw new VerificationError('ancestor_not_directory', dir);
    if (held.dev !== named.dev || held.ino !== named.ino) throw new VerificationError('handle_mismatch', dir);
    return { dir, dev: held.dev, ino: held.ino };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** The directories to verify: the resolved root down to the target's parent. */
function ancestorsBelow(rootReal: string, path: string): string[] {
  const dirs: string[] = [];
  let cursor = dirname(path);
  while (isWithin(cursor, rootReal)) {
    dirs.unshift(cursor);
    if (cursor === rootReal) break;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (dirs[0] !== rootReal) dirs.unshift(rootReal);
  return dirs;
}

/**
 * Open `path` (a confined real path) with `flags` (never `O_TRUNC` — the
 * caller truncates the verified handle) and return the handle only after its
 * ancestry and identity verified. Throws `VerificationError` otherwise; the
 * handle is closed before the throw. Exported for its own tests.
 */
export async function openVerified(path: string, flags: number, mode: number | undefined, roots: readonly string[], primitives: FsPrimitives): Promise<OpenHandle> {
  if ((flags & fsConstants.O_TRUNC) !== 0) throw new VerificationError('o_trunc_forbidden', path);

  let rootReal: string | null = null;
  for (const root of roots) {
    let real: string;
    try {
      real = posix.normalize(await primitives.realpath(root));
    } catch {
      continue;
    }
    if (isWithin(path, real)) {
      rootReal = real;
      break;
    }
  }
  if (rootReal === null) throw new VerificationError('outside_root', path);

  // 1. walk the ancestry, recording each verified directory's identity.
  const recorded: DirIdentity[] = [];
  for (const dir of ancestorsBelow(rootReal, path)) recorded.push(await verifyDirectory(dir, primitives));

  // 2. open the target itself, never following a link, never truncating.
  const handle = await primitives.open(path, flags | NOFOLLOW, mode);
  try {
    const held = await handle.stat();
    if (!held.isFile()) throw new VerificationError('not_regular_file', path);
    const named = await primitives.lstat(path);
    if (named.isSymbolicLink()) throw new VerificationError('symlink', path);
    if (held.dev !== named.dev || held.ino !== named.ino) throw new VerificationError('handle_mismatch', path);

    // 3. every ancestor must still be the directory it was when walked.
    for (const identity of recorded) {
      const again = await primitives.lstat(identity.dir);
      if (again.isSymbolicLink() || !again.isDirectory() || again.dev !== identity.dev || again.ino !== identity.ino) {
        throw new VerificationError('ancestor_replaced', identity.dir);
      }
    }

    // 4. Linux: ask the kernel where the fd really points.
    if (primitives.platform === 'linux') {
      const real = posix.normalize(await primitives.realpath(`/proc/self/fd/${handle.fd}`));
      if (!isWithin(real, rootReal)) throw new VerificationError('escaped_root', `${path} -> ${real}`);
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export function createFsRunner(primitives: FsPrimitives = createFsRunner.nodePrimitives()): FsRunner {
  return {
    async read(request, options) {
      if (request.op !== 'fs_read') return { kind: 'error', error: 'not an fs_read request' };
      const [path, ...rest] = request.paths;
      if (path === undefined) return { kind: 'error', error: 'no path' };
      if (rest.length > 0) return { kind: 'unsupported', reason: 'multi_path_read' };
      let handle: OpenHandle;
      try {
        handle = await openVerified(path, fsConstants.O_RDONLY, undefined, options.roots, primitives);
      } catch (error) {
        if (codeOf(error) === 'ENOENT') return { kind: 'read', found: false };
        return { kind: 'error', error: messageOf(error) };
      }
      try {
        const size = Number((await handle.stat()).size);
        if (size > options.maxContentBytes) return { kind: 'too_large', size, maxContentBytes: options.maxContentBytes };
        const content = await handle.readFile();
        if (content.length > options.maxContentBytes) return { kind: 'too_large', size: content.length, maxContentBytes: options.maxContentBytes };
        return { kind: 'read', found: true, contentB64: content.toString('base64') };
      } catch (error) {
        return { kind: 'error', error: messageOf(error) };
      } finally {
        await handle.close().catch(() => undefined);
      }
    },
    async write(request, files, options) {
      if (request.op !== 'fs_write') return { kind: 'write', ok: false, error: 'not an fs_write request' };
      if (files.length !== request.paths.length) return { kind: 'write', ok: false, error: 'files/paths length mismatch' };
      for (let index = 0; index < files.length; index += 1) {
        const path = request.paths[index] as string;
        const file = files[index] as FsWriteContent;
        let handle: OpenHandle;
        try {
          handle = await openVerified(path, fsConstants.O_WRONLY | fsConstants.O_CREAT, file.mode ?? DEFAULT_WRITE_MODE, options.roots, primitives);
        } catch (error) {
          return { kind: 'write', ok: false, error: `${path}: ${messageOf(error)}` };
        }
        try {
          // 5. the handle is verified: apply the mode (open only honours it on
          // create, so an EXISTING file needs an explicit chmod), truncate, write.
          if (file.mode !== null) await handle.chmod(file.mode);
          await handle.truncate(0);
          await handle.writeFile(Buffer.from(file.contentB64, 'base64'));
        } catch (error) {
          return { kind: 'write', ok: false, error: `${path}: ${messageOf(error)}` };
        } finally {
          await handle.close().catch(() => undefined);
        }
      }
      return { kind: 'write', ok: true };
    },
  };
}

/** The real primitives, exposed so a test can wrap them with a hook. */
createFsRunner.nodePrimitives = function nodePrimitives(): FsPrimitives {
  return {
    platform: process.platform,
    open: async (path, flags, mode) => {
      const handle = await fsp.open(path, flags, mode);
      return {
        fd: handle.fd,
        stat: () => handle.stat(),
        readFile: () => handle.readFile(),
        writeFile: (data) => handle.writeFile(data),
        truncate: (length) => handle.truncate(length),
        chmod: (mode) => handle.chmod(mode),
        close: () => handle.close(),
      };
    },
    lstat: (path) => fsp.lstat(path),
    realpath: (path) => fsp.realpath(path),
  };
};
