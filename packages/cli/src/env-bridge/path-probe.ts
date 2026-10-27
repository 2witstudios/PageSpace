/**
 * The filesystem probe `confinePath` resolves through, built on
 * `fs.realpathSync` / `fs.lstatSync` (t02 review, added requirement): a
 * probe error must surface as the FAIL-CLOSED answer, never as "missing".
 * Only `ENOENT` means the path is not there; EACCES, ELOOP, ENOTDIR and
 * anything else are rethrown, which `confinePath` treats as the worst answer
 * (unresolvable / "a symlink"). Mapping them to "missing" would let an
 * unreadable existing path be walked up and returned as a new-file write.
 *
 * `createStatMode` is the second probe this file owns (Codex P1 on hardening
 * A): the permission bits a file ALREADY has, for the sensitive-write
 * classifier. Its posture is the opposite of `realpath`'s and deliberately so
 * — it answers a question that can only ADD an escalation, so an error of any
 * kind is "no existing file" rather than a thrown failure: an unreadable file
 * must not take the daemon down, and a REQUESTED executable bit is still
 * caught without it.
 */
import { lstatSync, realpathSync, statSync } from 'node:fs';
import type { PathProbe } from './lib-core.js';

export interface ProbeFs {
  readonly realpath: (path: string) => string;
  readonly isSymbolicLink: (path: string) => boolean;
  /** POSIX permission bits of an existing file. */
  readonly mode: (path: string) => number;
}

const codeOf = (error: unknown): string | undefined => (typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined);

export function createPathProbe(fs: ProbeFs = nodeProbeFs()): PathProbe {
  return {
    realpath: (path) => {
      try {
        return fs.realpath(path);
      } catch (error) {
        if (codeOf(error) === 'ENOENT') return null;
        throw error;
      }
    },
    isSymlink: (path) => {
      try {
        return fs.isSymbolicLink(path);
      } catch (error) {
        if (codeOf(error) === 'ENOENT') return false;
        throw error;
      }
    },
  };
}

/**
 * The mode an existing file has, or `null` for anything else — it does not
 * exist, it cannot be read, it is not a file. Called by `decideExecution` only
 * for an `fs_write` whose request names no mode, and only on a CONFINED real
 * path, so `stat` (not `lstat`) is right: the symlink question was already
 * settled by `confinePath`.
 */
export function createStatMode(fs: ProbeFs = nodeProbeFs()): (path: string) => number | null {
  return (path) => {
    try {
      return fs.mode(path) & 0o7777;
    } catch {
      return null;
    }
  };
}

function nodeProbeFs(): ProbeFs {
  return {
    realpath: (path) => realpathSync(path),
    isSymbolicLink: (path) => lstatSync(path).isSymbolicLink(),
    mode: (path) => statSync(path).mode,
  };
}
