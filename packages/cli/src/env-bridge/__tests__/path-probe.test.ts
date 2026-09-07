import { describe, expect, it } from 'vitest';
import { confinePath } from '@pagespace/lib/env-bridge/confine-path';
import { createPathProbe, type ProbeFs } from '../path-probe.js';

const errno = (code: string) => Object.assign(new Error(code), { code });

function fs(behaviour: { realpath?: () => string; lstat?: () => boolean }): ProbeFs {
  return {
    realpath: behaviour.realpath ?? (() => { throw errno('ENOENT'); }),
    isSymbolicLink: behaviour.lstat ?? (() => { throw errno('ENOENT'); }),
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
