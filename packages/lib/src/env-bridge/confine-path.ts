/**
 * Path confinement for the user's machine (invariant 4): every path an agent
 * names to an fs operation, and every cwd, must resolve inside a directory the
 * machine owner declared as a root. (What a command does once it runs is gated
 * by the owner's ask/allowlist policy, not by this module — see the limit
 * stated in `decide-execution.ts`.)
 *
 * Two layers, in order. A LEXICAL check first — any `..` segment is refused
 * outright (even one that would land back inside the root; fail closed), and
 * the normalized path must sit under a root with a real path-boundary match,
 * not a string prefix (`/home/u/proj2` is not inside `/home/u/proj`). Roots are
 * owner-declared, so they are resolved up front and a path is accepted under a
 * root's declared form OR its real form — a follow-up request naming the real
 * path a previous allow returned (macOS `/tmp` → `/private/tmp`) must not be
 * refused. A declared root that no longer resolves confines nothing: a request
 * under it is `unresolvable`. Only a REQUEST path that passes lexically reaches
 * the probe.
 *
 * The second layer resolves the request through the injected `PathProbe` and
 * checks the answer against the roots' OWN real paths, so a symlink inside a
 * root cannot escape it. Paths that do not exist yet (new-file writes) resolve
 * through their nearest existing ancestor with the missing tail appended — but
 * every missing component is checked with `isSymlink`, because a DANGLING
 * symlink also fails `realpath` and a write through it would land wherever it
 * points. A bare `realpath` function is still accepted for callers that cannot
 * supply `isSymlink`; it keeps the older, stricter behaviour (a missing leaf is
 * `unresolvable`) rather than silently loosening.
 *
 * PROBE ERRORS FAIL CLOSED. EACCES, ELOOP, ENOTDIR and friends must never look
 * like "missing" — otherwise an unreadable existing path would be walked up
 * and returned as a new-file write. A probe that throws is therefore treated
 * as the WORST answer: a throwing `realpath` makes the path (or the root)
 * unresolvable, and a throwing `isSymlink` is treated as "yes, a symlink".
 * Adapters may equally return that worst answer themselves.
 *
 * Pure: `node:path`'s POSIX functions are string manipulation; the only
 * filesystem knowledge is the injected probe. Relative paths resolve against
 * the FIRST root.
 */
import { posix } from 'node:path';

export type ConfinePathDenyReason = 'malformed' | 'traversal' | 'outside_root' | 'symlink_escape' | 'no_roots' | 'unresolvable';

export type ConfinePathVerdict = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: ConfinePathDenyReason };

/** Resolve symlinks; `null` when the path does not exist (or is a dangling link). Injected. */
export type Realpath = (path: string) => string | null;

/**
 * Filesystem probe. `isSymlink` answers from an lstat-style view: true for a
 * symlink whether or not its target exists; false for a regular entry or a
 * path that does not exist at all. On ANY error (EACCES, ELOOP, ENOTDIR, …)
 * either method may throw, or `isSymlink` may return true / `realpath` null —
 * all of which fail closed here. Never map an error to "missing".
 */
export interface PathProbe {
  readonly realpath: Realpath;
  readonly isSymlink: (path: string) => boolean;
}

export type PathResolver = Realpath | PathProbe;

/** Strip trailing slashes so `/a/b/` and `/a/b` name the same directory (never touches `/`). */
function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.replace(/\/+$/, '') : path;
}

function normalizePath(path: string): string {
  return stripTrailingSlash(posix.normalize(path));
}

function isWithin(target: string, root: string): boolean {
  if (target === root) return true;
  const boundary = root.endsWith('/') ? root : `${root}/`;
  return target.startsWith(boundary);
}

/** `realpath` that never throws: an error is the worst answer, "unresolvable". */
function realpathOrNull(probe: PathProbe, path: string): string | null {
  try {
    return probe.realpath(path);
  } catch {
    return null;
  }
}

/** `isSymlink` that never throws: an error is the worst answer, "a symlink". */
function isSymlinkOrTrue(probe: PathProbe, path: string): boolean {
  try {
    return probe.isSymlink(path);
  } catch {
    return true;
  }
}

function deny(reason: ConfinePathDenyReason): ConfinePathVerdict {
  return { ok: false, reason };
}

/**
 * Resolve a path that does not exist: walk up to the nearest existing ancestor
 * via `realpath`, refusing any missing component that lstat says is a symlink
 * (dangling), and append the missing tail to the ancestor's real path.
 */
function resolveMissing(absolute: string, probe: PathProbe): { readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: 'symlink_escape' | 'unresolvable' } {
  const tail: string[] = [];
  let cursor = absolute;
  for (;;) {
    if (isSymlinkOrTrue(probe, cursor)) return { ok: false, reason: 'symlink_escape' };
    const parent = posix.dirname(cursor);
    if (parent === cursor) return { ok: false, reason: 'unresolvable' };
    tail.unshift(posix.basename(cursor));
    const parentReal = realpathOrNull(probe, parent);
    if (parentReal !== null) return { ok: true, path: posix.join(parentReal, ...tail) };
    cursor = parent;
  }
}

/**
 * Confine `requested` to `roots`.
 * @returns the REAL path to use (existing paths fully resolved; new paths as
 * `<real ancestor>/<missing tail>`), or a closed-union deny reason.
 */
export function confinePath(requested: string, roots: readonly string[], resolver: PathResolver): ConfinePathVerdict {
  if (roots.length === 0) return deny('no_roots');
  if (requested.includes('\0')) return deny('malformed');
  if (requested.split('/').includes('..')) return deny('traversal');

  const probe: PathProbe = typeof resolver === 'function' ? { realpath: resolver, isSymlink: () => false } : resolver;
  const canCreate = typeof resolver !== 'function';

  const normalizedRoots = roots.map(normalizePath);
  const primaryRoot = normalizedRoots[0] as string;
  const absolute = normalizePath(posix.isAbsolute(requested) ? requested : posix.join(primaryRoot, requested));

  // Roots are owner-declared: resolving them is safe and lets the lexical layer
  // accept either form of a symlinked root. A root that fails to resolve is
  // dead — it confines nothing.
  const liveDeclared: string[] = [];
  const deadDeclared: string[] = [];
  const realRoots: string[] = [];
  for (const root of normalizedRoots) {
    const real = realpathOrNull(probe, root);
    if (real === null) {
      deadDeclared.push(root);
    } else {
      liveDeclared.push(root);
      realRoots.push(normalizePath(real));
    }
  }
  if (realRoots.length === 0) return deny('unresolvable');

  const lexicalRoots = [...liveDeclared, ...realRoots];
  if (!lexicalRoots.some((root) => isWithin(absolute, root))) {
    return deadDeclared.some((root) => isWithin(absolute, root)) ? deny('unresolvable') : deny('outside_root');
  }

  let real: string;
  let existing: string | null;
  try {
    existing = probe.realpath(absolute);
  } catch {
    // An error on the REQUEST path is never "missing": it must not be walked
    // up and returned as a new-file write.
    return deny('unresolvable');
  }
  if (existing !== null) {
    real = normalizePath(existing);
  } else {
    if (!canCreate) return deny('unresolvable');
    const resolved = resolveMissing(absolute, probe);
    if (!resolved.ok) return deny(resolved.reason);
    real = normalizePath(resolved.path);
  }

  if (!realRoots.some((root) => isWithin(real, root))) return deny('symlink_escape');
  return { ok: true, path: real };
}
