import { describe, it, expect } from 'vitest';
import { confinePath, type PathProbe } from '../confine-path';

const ROOT = '/home/u/proj';

/**
 * An injected probe over a tiny fake filesystem. `realpath` returns the mapped
 * value for known paths, null for unknown ones; `isSymlink` is true only for
 * paths listed as symlinks (dangling or not).
 */
function probe(fs: { real?: Record<string, string>; symlinks?: string[] }): PathProbe {
  const real = fs.real ?? {};
  const symlinks = new Set(fs.symlinks ?? []);
  return {
    realpath: (p) => (p in real ? (real[p] as string) : null),
    isSymlink: (p) => symlinks.has(p),
  };
}

/** Identity filesystem: every path under the root exists as itself. */
const identityProbe: PathProbe = {
  realpath: (p) => (p === ROOT || p.startsWith(`${ROOT}/`) || p === '/other' || p.startsWith('/other/') ? p : null),
  isSymlink: () => false,
};

/** A bare realpath function (the legacy injection): identity under the root. */
const identityRealpath = (p: string): string | null => identityProbe.realpath(p);

describe('confinePath — every filesystem path an agent names must resolve inside a declared root', () => {
  it('given a path inside the root, should return ok with the resolved real path', () => {
    expect(confinePath(`${ROOT}/src/index.ts`, [ROOT], identityProbe)).toEqual({ ok: true, path: `${ROOT}/src/index.ts` });
  });

  it('given the root itself, should return ok', () => {
    expect(confinePath(ROOT, [ROOT], identityProbe)).toEqual({ ok: true, path: ROOT });
  });

  it('given a root declared WITH a trailing slash, should still accept the root itself and paths under it (minor: trailing-slash root)', () => {
    expect(confinePath(ROOT, [`${ROOT}/`], identityProbe)).toEqual({ ok: true, path: ROOT });
    expect(confinePath(`${ROOT}/x`, [`${ROOT}/`], identityProbe)).toEqual({ ok: true, path: `${ROOT}/x` });
  });

  it('given a path with a .. segment, should deny traversal even if it would land inside the root (fail closed)', () => {
    expect(confinePath('../etc/passwd', [ROOT], identityProbe)).toEqual({ ok: false, reason: 'traversal' });
    expect(confinePath(`${ROOT}/a/../b`, [ROOT], identityProbe)).toEqual({ ok: false, reason: 'traversal' });
  });

  it('given an absolute path outside every root, should deny outside_root', () => {
    expect(confinePath('/etc/passwd', [ROOT], identityProbe)).toEqual({ ok: false, reason: 'outside_root' });
  });

  it('given a sibling directory that merely shares the root as a string prefix, should deny outside_root (no startsWith trick)', () => {
    expect(confinePath('/home/u/proj2/x', [ROOT], identityProbe)).toEqual({ ok: false, reason: 'outside_root' });
  });

  it('given a symlink inside the root that resolves outside it, should deny symlink_escape', () => {
    const p = probe({ real: { [ROOT]: ROOT, [`${ROOT}/link`]: '/etc/shadow' }, symlinks: [`${ROOT}/link`] });
    expect(confinePath(`${ROOT}/link`, [ROOT], p)).toEqual({ ok: false, reason: 'symlink_escape' });
  });

  it("given a root that is itself a symlink, should compare against the root's real path and allow", () => {
    const p = probe({ real: { [ROOT]: '/private/home/u/proj', [`${ROOT}/x`]: '/private/home/u/proj/x' } });
    expect(confinePath(`${ROOT}/x`, [ROOT], p)).toEqual({ ok: true, path: '/private/home/u/proj/x' });
  });

  it('given a FOLLOW-UP request naming the real path a previous allow returned (symlinked root, e.g. macOS /tmp), should allow (major: symlinked roots)', () => {
    const p = probe({ real: { '/tmp': '/private/tmp', '/private/tmp': '/private/tmp', '/private/tmp/x': '/private/tmp/x' } });
    expect(confinePath('/private/tmp/x', ['/tmp'], p)).toEqual({ ok: true, path: '/private/tmp/x' });
  });

  it('given a DELETED root among several, should deny unresolvable for a request under it — not a misleading symlink_escape (a dead root confines nothing)', () => {
    const p = probe({ real: { '/other': '/other', '/other/y': '/other/y' } });
    expect(confinePath(`${ROOT}/x`, [ROOT, '/other'], p)).toEqual({ ok: false, reason: 'unresolvable' });
    expect(confinePath('/other/y', [ROOT, '/other'], p)).toEqual({ ok: true, path: '/other/y' });
  });

  describe('probe errors fail closed (EACCES / ELOOP / ENOTDIR must never look like "missing")', () => {
    it('given realpath that THROWS on the request path, should deny unresolvable rather than treating it as a new file', () => {
      const p: PathProbe = { realpath: (x) => { if (x === ROOT) return ROOT; throw new Error('EACCES'); }, isSymlink: () => false };
      expect(confinePath(`${ROOT}/secret`, [ROOT], p)).toEqual({ ok: false, reason: 'unresolvable' });
    });

    it('given isSymlink that THROWS while walking a missing path, should deny symlink_escape (an unknowable component is treated as a symlink)', () => {
      const p: PathProbe = { realpath: (x) => (x === ROOT ? ROOT : null), isSymlink: () => { throw new Error('ELOOP'); } };
      expect(confinePath(`${ROOT}/new.txt`, [ROOT], p)).toEqual({ ok: false, reason: 'symlink_escape' });
    });

    it('given realpath that THROWS on a root, should treat that root as unresolved', () => {
      const p: PathProbe = { realpath: (x) => { if (x === ROOT) throw new Error('EACCES'); return x; }, isSymlink: () => false };
      expect(confinePath(`${ROOT}/x`, [ROOT], p)).toEqual({ ok: false, reason: 'unresolvable' });
    });
  });

  it('given no roots, should deny no_roots', () => {
    expect(confinePath(`${ROOT}/x`, [], identityProbe)).toEqual({ ok: false, reason: 'no_roots' });
  });

  it('given every root unresolvable (directory deleted), should deny unresolvable — not a misleading symlink_escape (nit)', () => {
    const p = probe({ real: { [`${ROOT}/x`]: `${ROOT}/x` } });
    expect(confinePath(`${ROOT}/x`, [ROOT], p)).toEqual({ ok: false, reason: 'unresolvable' });
  });

  it('given a relative path without .., should resolve it against the FIRST root', () => {
    expect(confinePath('src/x.ts', [ROOT, '/other'], identityProbe)).toEqual({ ok: true, path: `${ROOT}/src/x.ts` });
  });

  it('given several roots, should allow a path inside any of them', () => {
    expect(confinePath('/other/y', [ROOT, '/other'], identityProbe)).toEqual({ ok: true, path: '/other/y' });
  });

  it('given a path containing a NUL byte, should deny malformed (never reaches the filesystem; distinct reason for the audit log)', () => {
    expect(confinePath(`${ROOT}/a\0b`, [ROOT], identityProbe)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('should never probe a REQUEST path that already failed the lexical check (roots may be resolved up front — they are owner-declared)', () => {
    const requestCalls: string[] = [];
    const spy: PathProbe = {
      realpath: (p) => { if (p !== ROOT) requestCalls.push(p); return p; },
      isSymlink: () => false,
    };
    confinePath('/etc/passwd', [ROOT], spy);
    confinePath('../x', [ROOT], spy);
    confinePath(`${ROOT}/a\0b`, [ROOT], spy);
    expect(requestCalls).toEqual([]);
  });

  describe('paths that do not exist yet (new-file writes — Codex P1 / major)', () => {
    it('given a missing leaf whose parent exists inside the root, should allow with the parent resolved and the leaf appended', () => {
      const p = probe({ real: { [ROOT]: ROOT, [`${ROOT}/src`]: `${ROOT}/src` } });
      expect(confinePath(`${ROOT}/src/new.ts`, [ROOT], p)).toEqual({ ok: true, path: `${ROOT}/src/new.ts` });
    });

    it('given several missing components, should resolve the nearest existing ancestor and append the rest', () => {
      const p = probe({ real: { [ROOT]: ROOT } });
      expect(confinePath(`${ROOT}/a/b/c.txt`, [ROOT], p)).toEqual({ ok: true, path: `${ROOT}/a/b/c.txt` });
    });

    it('given a missing leaf under a symlinked root, should return the path under the ROOT\'s real path', () => {
      const p = probe({ real: { '/tmp': '/private/tmp', '/private/tmp': '/private/tmp' } });
      expect(confinePath('/tmp/new.txt', ['/tmp'], p)).toEqual({ ok: true, path: '/private/tmp/new.txt' });
    });

    it('given a DANGLING symlink at the leaf, should deny symlink_escape (a write through it would land wherever it points)', () => {
      const p = probe({ real: { [ROOT]: ROOT }, symlinks: [`${ROOT}/dangling`] });
      expect(confinePath(`${ROOT}/dangling`, [ROOT], p)).toEqual({ ok: false, reason: 'symlink_escape' });
    });

    it('given a dangling symlink as an INTERMEDIATE component of a missing path, should deny symlink_escape', () => {
      const p = probe({ real: { [ROOT]: ROOT }, symlinks: [`${ROOT}/gone`] });
      expect(confinePath(`${ROOT}/gone/new.txt`, [ROOT], p)).toEqual({ ok: false, reason: 'symlink_escape' });
    });

    it('given an existing ancestor that is a symlink resolving OUTSIDE the root, should deny symlink_escape even though the leaf is new', () => {
      const p = probe({ real: { [ROOT]: ROOT, [`${ROOT}/out`]: '/etc' }, symlinks: [`${ROOT}/out`] });
      expect(confinePath(`${ROOT}/out/new.txt`, [ROOT], p)).toEqual({ ok: false, reason: 'symlink_escape' });
    });

    it('given a bare realpath FUNCTION (no isSymlink probe), should keep the fail-closed legacy behaviour: a missing leaf is unresolvable', () => {
      const bare = (p: string): string | null => (p === ROOT ? ROOT : null);
      expect(confinePath(`${ROOT}/new.ts`, [ROOT], bare)).toEqual({ ok: false, reason: 'unresolvable' });
      expect(confinePath(ROOT, [ROOT], identityRealpath)).toEqual({ ok: true, path: ROOT });
    });
  });
});
