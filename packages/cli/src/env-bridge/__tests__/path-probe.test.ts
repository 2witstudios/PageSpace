import { describe, expect, it } from 'vitest';
import { confinePath } from '@pagespace/lib/env-bridge/confine-path';
import { createPathProbe, createStatMode, type ProbeFs } from '../path-probe.js';

const errno = (code: string) => Object.assign(new Error(code), { code });

function fs(behaviour: { realpath?: () => string; lstat?: () => boolean; mode?: () => number }): ProbeFs {
  return {
    realpath: behaviour.realpath ?? (() => { throw errno('ENOENT'); }),
    isSymbolicLink: behaviour.lstat ?? (() => { throw errno('ENOENT'); }),
    mode: behaviour.mode ?? (() => { throw errno('ENOENT'); }),
  };
}

describe('path-probe adapter (added requirement: every probe error fails closed, never "missing")', () => {
  it('ENOENT is the ONLY code that means missing: realpath → null, isSymlink → false', () => {
    const probe = createPathProbe(fs({}));
    expect(probe.realpath('/x')).toBeNull();
    expect(probe.isSymlink('/x')).toBe(false);
  });

  it.each(['EACCES', 'ELOOP', 'ENOTDIR', 'EIO', 'EPERM'])('%s from realpath is rethrown so confinePath answers unresolvable — not walked up as a new-file write', (code) => {
    const probe = createPathProbe(fs({ realpath: () => { throw errno(code); }, lstat: () => false }));
    expect(() => probe.realpath('/root/x')).toThrow(code);
    expect(confinePath('/root/x', ['/root'], probe)).toEqual({ ok: false, reason: 'unresolvable' });
  });

  it.each(['EACCES', 'ELOOP', 'ENOTDIR'])('%s from lstat is rethrown so confinePath treats the component as a symlink (fail closed)', (code) => {
    const calls: string[] = [];
    const probe = createPathProbe(
      fs({
        realpath: (path?: string) => {
          calls.push(String(path));
          if (calls.length === 1) return '/root';
          throw errno('ENOENT');
        },
        lstat: () => { throw errno(code); },
      }),
    );
    expect(() => probe.isSymlink('/root/new')).toThrow(code);
    expect(confinePath('/root/new', ['/root'], probe)).toEqual({ ok: false, reason: 'symlink_escape' });
  });

  it('a live path resolves through the real function', () => {
    const probe = createPathProbe(fs({ realpath: () => '/real/root', lstat: () => false }));
    expect(probe.realpath('/root')).toBe('/real/root');
  });
});

describe('createStatMode — the OPPOSITE posture to realpath, deliberately (Codex P1 on hardening A)', () => {
  it('given an existing file, should answer its permission bits with the file-type bits stripped', () => {
    // 0o100755 is what stat reports for a regular file at 0o755.
    expect(createStatMode(fs({ mode: () => 0o100755 }))('/root/bin/tool')).toBe(0o755);
    expect(createStatMode(fs({ mode: () => 0o100644 }))('/root/src/a.ts')).toBe(0o644);
    expect(createStatMode(fs({ mode: () => 0o104755 }))('/root/bin/setuid')).toBe(0o4755);
  });

  it.each(['ENOENT', 'EACCES', 'ELOOP', 'ENOTDIR', 'EIO', 'EPERM'])('given %s, should answer null rather than throw — this probe can only ADD an escalation, so an error must never take the daemon down', (code) => {
    const statMode = createStatMode(fs({ mode: () => { throw errno(code); } }));
    expect(() => statMode('/root/x')).not.toThrow();
    expect(statMode('/root/x')).toBeNull();
  });
});
