/**
 * The fs runner — reads and writes ONLY the confined real paths a
 * `NormalizedRequest` carries (`confinePath` output, never a wire path), with
 * the Codex C9 mitigation: confinement resolved a PATHNAME, and a pathname
 * can be re-pointed between the check and the use. So every operation opens
 * the confined path with `O_NOFOLLOW` (the final component may not be a
 * symlink at open time) and then re-checks the OPEN HANDLE: `fstat` must say
 * a regular file, and its `dev`/`ino` must match an `lstat` of the pathname
 * taken after the open (`checkOpenHandle`). A handle that is not the inode
 * currently at that path, or that path having become a link, is refused and
 * nothing is read or written through it. Parent-directory swaps are covered
 * by the same inode identity check.
 *
 * Content crosses this boundary as base64 (the wire form); nothing here
 * interprets it. `fs_read` serves exactly ONE path: the `fs_read_result`
 * frame carries one content, so a multi-path read is refused as unsupported
 * rather than silently answered with the first file.
 */
import { promises as fsp, constants as fsConstants } from 'node:fs';
import type { NormalizedRequest } from '@pagespace/lib/env-bridge/decide-execution';

export interface HandleStats {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  isFile(): boolean;
}

export interface PathStats extends HandleStats {
  isSymbolicLink(): boolean;
}

export interface OpenHandle {
  stat(): Promise<HandleStats>;
  readFile(): Promise<Buffer>;
  writeFile(data: Buffer): Promise<void>;
  close(): Promise<void>;
}

export interface FsPrimitives {
  open(path: string, flags: number, mode?: number): Promise<OpenHandle>;
  lstat(path: string): Promise<PathStats>;
}

export type ReadOutcome = { readonly kind: 'read'; readonly found: boolean; readonly contentB64?: string } | { readonly kind: 'unsupported'; readonly reason: 'multi_path_read' } | { readonly kind: 'error'; readonly error: string };
export type WriteOutcome = { readonly kind: 'write'; readonly ok: boolean; readonly error?: string };

export interface FsWriteContent {
  readonly contentB64: string;
  readonly mode: number | null;
}

export interface FsRunner {
  read(request: NormalizedRequest): Promise<ReadOutcome>;
  write(request: NormalizedRequest, files: readonly FsWriteContent[]): Promise<WriteOutcome>;
}

export type HandleCheck = { readonly ok: true } | { readonly ok: false; readonly reason: 'not_regular_file' | 'handle_mismatch' | 'symlink' };

const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const DEFAULT_WRITE_MODE = 0o644;

/** C9: is the handle we hold the regular file currently at `path`? */
export async function checkOpenHandle(handle: OpenHandle, path: string, primitives: FsPrimitives): Promise<HandleCheck> {
  const held = await handle.stat();
  if (!held.isFile()) return { ok: false, reason: 'not_regular_file' };
  const now = await primitives.lstat(path);
  if (now.isSymbolicLink()) return { ok: false, reason: 'symlink' };
  if (held.dev !== now.dev || held.ino !== now.ino) return { ok: false, reason: 'handle_mismatch' };
  return { ok: true };
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const codeOf = (error: unknown): string | undefined => (typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined);

export function createFsRunner(primitives: FsPrimitives = nodePrimitives()): FsRunner {
  const withHandle = async <T>(path: string, flags: number, mode: number | undefined, use: (handle: OpenHandle) => Promise<T>): Promise<T> => {
    const handle = await primitives.open(path, flags, mode);
    try {
      const check = await checkOpenHandle(handle, path, primitives);
      if (!check.ok) throw new Error(`refusing ${path}: ${check.reason}`);
      return await use(handle);
    } finally {
      await handle.close().catch(() => undefined);
    }
  };

  return {
    async read(request) {
      if (request.op !== 'fs_read') return { kind: 'error', error: 'not an fs_read request' };
      const [path, ...rest] = request.paths;
      if (path === undefined) return { kind: 'error', error: 'no path' };
      if (rest.length > 0) return { kind: 'unsupported', reason: 'multi_path_read' };
      try {
        const content = await withHandle(path, fsConstants.O_RDONLY | NOFOLLOW, undefined, (handle) => handle.readFile());
        return { kind: 'read', found: true, contentB64: content.toString('base64') };
      } catch (error) {
        if (codeOf(error) === 'ENOENT') return { kind: 'read', found: false };
        return { kind: 'error', error: messageOf(error) };
      }
    },
    async write(request, files) {
      if (request.op !== 'fs_write') return { kind: 'write', ok: false, error: 'not an fs_write request' };
      if (files.length !== request.paths.length) return { kind: 'write', ok: false, error: 'files/paths length mismatch' };
      for (let index = 0; index < files.length; index += 1) {
        const path = request.paths[index] as string;
        const file = files[index] as FsWriteContent;
        try {
          const data = Buffer.from(file.contentB64, 'base64');
          await withHandle(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | NOFOLLOW, file.mode ?? DEFAULT_WRITE_MODE, (handle) => handle.writeFile(data));
        } catch (error) {
          return { kind: 'write', ok: false, error: `${path}: ${messageOf(error)}` };
        }
      }
      return { kind: 'write', ok: true };
    },
  };
}

function nodePrimitives(): FsPrimitives {
  return {
    open: async (path, flags, mode) => {
      const handle = await fsp.open(path, flags, mode);
      return {
        stat: () => handle.stat(),
        readFile: () => handle.readFile(),
        writeFile: (data) => handle.writeFile(data),
        close: () => handle.close(),
      };
    },
    lstat: (path) => fsp.lstat(path),
  };
}
