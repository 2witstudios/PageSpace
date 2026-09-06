/**
 * The filesystem probe `confinePath` resolves through, built on
 * `fs.realpathSync` / `fs.lstatSync` (t02 review, added requirement): a
 * probe error must surface as the FAIL-CLOSED answer, never as "missing".
 * Only `ENOENT` means the path is not there; EACCES, ELOOP, ENOTDIR and
 * anything else are rethrown, which `confinePath` treats as the worst answer
 * (unresolvable / "a symlink"). Mapping them to "missing" would let an
 * unreadable existing path be walked up and returned as a new-file write.
 */
import { lstatSync, realpathSync } from 'node:fs';
import type { PathProbe } from './lib-core.js';

export interface ProbeFs {
  readonly realpath: (path: string) => string;
  readonly isSymbolicLink: (path: string) => boolean;
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

function nodeProbeFs(): ProbeFs {
  return {
    realpath: (path) => realpathSync(path),
    isSymbolicLink: (path) => lstatSync(path).isSymbolicLink(),
  };
}
