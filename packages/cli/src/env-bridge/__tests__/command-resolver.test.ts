import { describe, expect, it } from 'vitest';
import { enhancedPathDirs, resolveCommand, type CommandResolverDeps } from '../command-resolver.js';

function deps(files: Record<string, 'x' | 'f' | 'd'>, overrides: Partial<CommandResolverDeps> = {}): CommandResolverDeps {
  return {
    platform: 'darwin',
    env: { PATH: '/custom/bin', HOME: '/home/me' },
    isExecutableFile: (path) => files[path] === 'x',
    isDirectory: (path) => files[path] === 'd',
    listDir: (path) => Object.keys(files).filter((entry) => entry.startsWith(`${path}/`) && !entry.slice(path.length + 1).includes('/')).map((entry) => entry.slice(path.length + 1)),
    ...overrides,
  };
}

describe('command-resolver (lifted from apps/desktop command-resolver.ts; fs-only — it never spawns `which`)', () => {
  it('given an absolute command, should return it unchanged', () => {
    expect(resolveCommand('/usr/bin/env', deps({}))).toBe('/usr/bin/env');
  });

  it('given a bare command present in the enhanced PATH, should return its absolute path, preferring the well-known dirs over the inherited PATH order', () => {
    const d = deps({ '/opt/homebrew/bin/node': 'x', '/custom/bin/node': 'x' });
    expect(resolveCommand('node', d)).toBe('/opt/homebrew/bin/node');
  });

  it('given a bare command found only on the inherited PATH, should still find it', () => {
    expect(resolveCommand('tool', deps({ '/custom/bin/tool': 'x' }))).toBe('/custom/bin/tool');
  });

  it('given a command that exists but is not executable, or does not exist, should return null', () => {
    expect(resolveCommand('tool', deps({ '/custom/bin/tool': 'f' }))).toBeNull();
    expect(resolveCommand('missing', deps({}))).toBeNull();
  });

  it('given a relative path containing a separator, should return null — the runner resolves only bare names or absolute paths', () => {
    expect(resolveCommand('./run.sh', deps({}))).toBeNull();
  });

  it('should expand nvm / fnm version directories to their bin dirs', () => {
    const d = deps({
      '/home/me/.nvm/versions/node': 'd',
      '/home/me/.nvm/versions/node/v22.0.0': 'd',
      '/home/me/.nvm/versions/node/v22.0.0/bin': 'd',
      '/home/me/.fnm/node-versions': 'd',
      '/home/me/.fnm/node-versions/v20.0.0': 'd',
      '/home/me/.fnm/node-versions/v20.0.0/installation': 'd',
      '/home/me/.fnm/node-versions/v20.0.0/installation/bin': 'd',
    });
    const dirs = enhancedPathDirs(d);
    expect(dirs).toContain('/home/me/.nvm/versions/node/v22.0.0/bin');
    expect(dirs).toContain('/home/me/.fnm/node-versions/v20.0.0/installation/bin');
    expect(dirs[dirs.length - 1]).toBe('/custom/bin');
  });

  it('F (win32): a bare name is probed with PATHEXT extensions (node → node.exe), default extensions when PATHEXT is unset', () => {
    const win = deps({ 'C:\\Program Files\\nodejs/node.exe': 'x' }, { platform: 'win32', env: { PATH: 'C:\\tools', PATHEXT: '.COM;.EXE;.BAT' } });
    expect(resolveCommand('node', win)).toBe('C:\\Program Files\\nodejs/node.exe');
    const noPathext = deps({ 'C:\\tools/git.cmd': 'x' }, { platform: 'win32', env: { PATH: 'C:\\tools' } });
    expect(resolveCommand('git', noPathext)).toBe('C:\\tools/git.cmd');
    expect(resolveCommand('node', deps({ '/usr/local/bin/node.exe': 'x' }))).toBeNull();
  });

  it('given a listDir that throws, should skip that dir rather than fail the resolution', () => {
    const d = deps({ '/home/me/.nvm/versions/node': 'd', '/custom/bin/tool': 'x' }, { listDir: () => { throw new Error('EACCES'); } });
    expect(resolveCommand('tool', d)).toBe('/custom/bin/tool');
  });
});
