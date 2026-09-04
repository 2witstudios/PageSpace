/**
 * Path confinement for the user's machine (invariant 4): every cwd and every
 * file path an agent names must resolve inside a directory the machine owner
 * declared as a root.
 *
 * Two layers, in order. A LEXICAL check first — any `..` segment is refused
 * outright (even one that would land back inside the root; fail closed), and
 * the normalized path must sit under a root with a real path-boundary match,
 * not a string prefix (`/home/u/proj2` is not inside `/home/u/proj`). Only a
 * path that passes lexically reaches the injected `realpath`, whose answer is
 * then checked against the roots' OWN real paths, so a symlink inside a root
 * cannot escape it and a root that is itself a symlink (macOS `/tmp`) still
 * works.
 *
 * Pure: `node:path`'s POSIX functions are string manipulation; the only
 * filesystem knowledge is the injected `realpath`. Relative paths resolve
 * against the FIRST root.
 */
import { posix } from 'node:path';

export type ConfinePathDenyReason = 'traversal' | 'outside_root' | 'symlink_escape' | 'no_roots' | 'unresolvable';

export type ConfinePathVerdict = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: ConfinePathDenyReason };

/** Resolve symlinks; `null` when the path cannot be resolved. Injected. */
export type Realpath = (path: string) => string | null;

function isWithin(target: string, root: string): boolean {
  if (target === root) return true;
  const boundary = root.endsWith('/') ? root : `${root}/`;
  return target.startsWith(boundary);
}

function deny(reason: ConfinePathDenyReason): ConfinePathVerdict {
  return { ok: false, reason };
}

export function confinePath(requested: string, roots: readonly string[], realpath: Realpath): ConfinePathVerdict {
  if (roots.length === 0) return deny('no_roots');
  if (requested.includes('\0')) return deny('traversal');
  if (requested.split('/').includes('..')) return deny('traversal');

  const primaryRoot = roots[0] as string;
  const absolute = posix.isAbsolute(requested) ? posix.normalize(requested) : posix.normalize(posix.join(primaryRoot, requested));
  const normalizedRoots = roots.map((root) => posix.normalize(root));
  if (!normalizedRoots.some((root) => isWithin(absolute, root))) return deny('outside_root');

  const real = realpath(absolute);
  if (real === null) return deny('unresolvable');
  const realRoots = normalizedRoots.map(realpath).filter((root): root is string => root !== null);
  if (!realRoots.some((root) => isWithin(real, root))) return deny('symlink_escape');

  return { ok: true, path: real };
}
