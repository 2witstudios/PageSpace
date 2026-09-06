import { describe, expect, it, vi } from 'vitest';
import { closeSync, constants as fsConstants, fstatSync, mkdtempSync, mkdirSync, openSync, realpathSync, writeFileSync, symlinkSync, readFileSync, rmSync, statSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedRequest } from '@pagespace/lib/env-bridge/decide-execution';
import { createFsRunner, openVerified, type FsPrimitives, type OpenHandle, type PathStats } from '../fs-runner.js';

function request(op: 'fs_read' | 'fs_write', paths: string[]): NormalizedRequest {
  return { op, cwd: '/', paths, env: {}, timeoutMs: 1_000, maxBytes: 1_048_576, clamped: false };
}

const root = realpathSync(mkdtempSync(join(tmpdir(), 'ps-fs-runner-')));
const READ = { roots: [root], maxContentBytes: 1_048_576 };
const WRITE = { roots: [root] };

describe('fs-runner on the real filesystem (Codex C9: open via the confined path, verify the OPEN handle and its ancestry, never follow a link)', () => {
  const runner = createFsRunner();

  it('given one confined path that exists under a root, should read it back base64', async () => {
    const file = join(root, 'a.txt');
    writeFileSync(file, 'hello');
    expect(await runner.read(request('fs_read', [file]), READ)).toEqual({ kind: 'read', found: true, contentB64: Buffer.from('hello').toString('base64') });
  });

  it('given a path that does not exist, should answer found:false', async () => {
    expect(await runner.read(request('fs_read', [join(root, 'missing')]), READ)).toEqual({ kind: 'read', found: false });
  });

  it('given more than one path, should refuse as unsupported — the fs_read_result frame carries ONE content', async () => {
    expect(await runner.read(request('fs_read', [join(root, 'a.txt'), join(root, 'b.txt')]), READ)).toEqual({ kind: 'unsupported', reason: 'multi_path_read' });
  });

  it('given a path outside every root (a confinement bug upstream), should refuse before opening anything', async () => {
    const outcome = await runner.read(request('fs_read', ['/etc/hosts']), READ);
    expect(outcome).toMatchObject({ kind: 'error', error: expect.stringMatching(/outside_root/) });
  });

  it('given a symlink at the final component (swapped in after confinement), O_NOFOLLOW must refuse to open it — never follow it', async () => {
    writeFileSync(join(root, 'secret'), 'top');
    symlinkSync(join(root, 'secret'), join(root, 'link'));
    expect((await runner.read(request('fs_read', [join(root, 'link')]), READ)).kind).toBe('error');
  });

  it('given a symlinked ANCESTOR directory swapped in after confinement, the component walk must refuse (O_DIRECTORY|O_NOFOLLOW per component)', async () => {
    mkdirSync(join(root, 'real-dir'));
    writeFileSync(join(root, 'real-dir', 'f'), 'x');
    symlinkSync(join(root, 'real-dir'), join(root, 'linked-dir'));
    expect((await runner.read(request('fs_read', [join(root, 'linked-dir', 'f')]), READ)).kind).toBe('error');
  });

  it('given a directory where a file was expected, should fail closed (the handle re-check refuses a non-regular file)', async () => {
    mkdirSync(join(root, 'dir'));
    expect((await runner.read(request('fs_read', [join(root, 'dir')]), READ)).kind).toBe('error');
  });

  it('P2: given a file larger than maxContentBytes, should refuse too_large from fstat BEFORE reading it', async () => {
    const big = join(root, 'big.bin');
    writeFileSync(big, Buffer.alloc(2048, 7));
    expect(await runner.read(request('fs_read', [big]), { roots: [root], maxContentBytes: 1024 })).toEqual({ kind: 'too_large', size: 2048, maxContentBytes: 1024 });
  });

  it('given a write, should create the file with the requested mode (no O_TRUNC at open; ftruncate after verification) and answer ok', async () => {
    const file = join(root, 'new.txt');
    expect(await runner.write(request('fs_write', [file]), [{ contentB64: Buffer.from('written').toString('base64'), mode: 0o600 }], WRITE)).toEqual({ kind: 'write', ok: true });
    // One handle, inspected through the fd only (no check-then-use on the pathname).
    const first = openSync(file, 'r');
    try {
      expect(readFileSync(first, 'utf8')).toBe('written');
      expect(fstatSync(first).mode & 0o777).toBe(0o600);
    } finally {
      closeSync(first);
    }
    expect(await runner.write(request('fs_write', [file]), [{ contentB64: Buffer.from('shorter').toString('base64'), mode: null }], WRITE)).toEqual({ kind: 'write', ok: true });
    const second = openSync(file, 'r');
    try {
      expect(readFileSync(second, 'utf8')).toBe('shorter');
    } finally {
      closeSync(second);
    }
  });

  it('given a write whose target is a symlink, should refuse (O_NOFOLLOW) and answer ok:false — nothing written through the link', async () => {
    writeFileSync(join(root, 'target'), 'keep');
    symlinkSync(join(root, 'target'), join(root, 'wlink'));
    expect(await runner.write(request('fs_write', [join(root, 'wlink')]), [{ contentB64: Buffer.from('evil').toString('base64'), mode: null }], WRITE)).toMatchObject({ kind: 'write', ok: false });
    expect(readFileSync(join(root, 'target'), 'utf8')).toBe('keep');
  });

  it('given a files list whose length differs from the confined paths, should refuse before touching the disk', async () => {
    expect(await runner.write(request('fs_write', [join(root, 'x')]), [], WRITE)).toEqual({ kind: 'write', ok: false, error: 'files/paths length mismatch' });
  });

  it('given a directory renamed away between confinement and open, the write must not land anywhere (no dangling create) and the answer is ok:false', async () => {
    const dir = join(root, 'moving');
    mkdirSync(dir);
    const primitives = realPrimitivesWithHook(() => renameSync(dir, join(root, 'moved')));
    const hooked = createFsRunner(primitives);
    const outcome = await hooked.write(request('fs_write', [join(dir, 'f')]), [{ contentB64: 'aGk=', mode: null }], WRITE);
    expect(outcome).toMatchObject({ kind: 'write', ok: false });
    expect(() => statSync(join(root, 'moved', 'f'))).toThrow();
  });

  it('cleanup', () => {
    rmSync(root, { recursive: true, force: true });
  });
});

/** The real primitives, with a hook that fires once after the ancestry walk (before the final open). */
function realPrimitivesWithHook(afterWalk: () => void): FsPrimitives {
  const real = createFsRunner.nodePrimitives();
  let fired = false;
  return {
    ...real,
    open: async (path, flags, mode) => {
      if (!fired && (flags & fsConstants.O_DIRECTORY) === 0) {
        fired = true;
        afterWalk();
      }
      return real.open(path, flags, mode);
    },
  };
}

// ---- fake filesystem: ancestor swaps are testable only with a fake ----------

interface FakeEntry {
  kind: 'dir' | 'file' | 'symlink';
  ino: number;
  size?: number;
  content?: string;
}

function fakeFs(table: Record<string, FakeEntry>, options: { platform?: string; procFdTarget?: string; onOpen?: (path: string, flags: number) => void } = {}) {
  const calls = { opens: [] as Array<{ path: string; flags: number }>, reads: 0, writes: 0, truncates: 0 };
  const statsOf = (entry: FakeEntry): PathStats => ({ dev: 1, ino: entry.ino, size: entry.size ?? entry.content?.length ?? 0, isFile: () => entry.kind === 'file', isDirectory: () => entry.kind === 'dir', isSymbolicLink: () => entry.kind === 'symlink' });
  const missing = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  let nextFd = 10;
  const primitives: FsPrimitives = {
    platform: options.platform ?? 'darwin',
    realpath: async (path) => {
      if (path.startsWith('/proc/self/fd/')) return options.procFdTarget ?? path;
      if (!table[path]) throw missing();
      return path;
    },
    lstat: async (path) => {
      const entry = table[path];
      if (!entry) throw missing();
      return statsOf(entry);
    },
    open: async (path, flags) => {
      calls.opens.push({ path, flags });
      options.onOpen?.(path, flags);
      const entry = table[path];
      if (!entry) throw missing();
      const fd = nextFd++;
      const handle: OpenHandle = {
        fd,
        stat: async () => statsOf(table[path] ?? entry),
        readFile: async () => { calls.reads += 1; return Buffer.from(entry.content ?? ''); },
        writeFile: async () => { calls.writes += 1; },
        truncate: async () => { calls.truncates += 1; },
        close: async () => undefined,
      };
      return handle;
    },
  };
  return { primitives, calls, table };
}

const ROOT = '/root';
const BASE: Record<string, FakeEntry> = {
  '/root': { kind: 'dir', ino: 1 },
  '/root/proj': { kind: 'dir', ino: 2 },
  '/root/proj/f': { kind: 'file', ino: 3, content: 'inside' },
};

describe('fs-runner ancestry verification with a fake filesystem (the race a real fs cannot reproduce deterministically)', () => {
  it('CONTROL: the untouched table opens, walks root→proj with O_DIRECTORY|O_NOFOLLOW, verifies, and reads', async () => {
    const fake = fakeFs({ ...BASE });
    const runner = createFsRunner(fake.primitives);
    expect(await runner.read(request('fs_read', ['/root/proj/f']), { roots: [ROOT], maxContentBytes: 1024 })).toEqual({ kind: 'read', found: true, contentB64: Buffer.from('inside').toString('base64') });
    const dirOpens = fake.calls.opens.filter((o) => (o.flags & fsConstants.O_DIRECTORY) !== 0).map((o) => o.path);
    expect(dirOpens).toEqual(['/root', '/root/proj']);
    for (const o of fake.calls.opens) expect(o.flags & fsConstants.O_NOFOLLOW).not.toBe(0);
  });

  it('P1: an ANCESTOR replaced after the walk but before the final open is detected by the post-open re-walk — nothing is read', async () => {
    const table = { ...BASE };
    const fake = fakeFs(table, {
      onOpen: (path, flags) => {
        if ((flags & fsConstants.O_DIRECTORY) === 0 && path === '/root/proj/f') {
          // The attacker swaps /root/proj for a directory that lives outside; the file the open follows is theirs.
          table['/root/proj'] = { kind: 'dir', ino: 99 };
          table['/root/proj/f'] = { kind: 'file', ino: 100, content: 'OUTSIDE' };
        }
      },
    });
    const runner = createFsRunner(fake.primitives);
    const outcome = await runner.read(request('fs_read', ['/root/proj/f']), { roots: [ROOT], maxContentBytes: 1024 });
    expect(outcome).toMatchObject({ kind: 'error', error: expect.stringMatching(/ancestor_replaced/) });
    expect(fake.calls.reads).toBe(0);
  });

  it('P1: on a write, the same swap must leave truncate and writeFile uncalled, and O_TRUNC is NEVER passed to open', async () => {
    const table = { ...BASE };
    const fake = fakeFs(table, {
      onOpen: (path, flags) => {
        if ((flags & fsConstants.O_DIRECTORY) === 0 && path === '/root/proj/f') {
          table['/root/proj'] = { kind: 'dir', ino: 99 };
          table['/root/proj/f'] = { kind: 'file', ino: 100 };
        }
      },
    });
    const runner = createFsRunner(fake.primitives);
    expect(await runner.write(request('fs_write', ['/root/proj/f']), [{ contentB64: 'aGk=', mode: null }], { roots: [ROOT] })).toMatchObject({ kind: 'write', ok: false });
    expect(fake.calls.truncates).toBe(0);
    expect(fake.calls.writes).toBe(0);
    for (const o of fake.calls.opens) expect(o.flags & fsConstants.O_TRUNC).toBe(0);
  });

  it('CONTROL: an untouched write truncates AFTER verification and then writes', async () => {
    const fake = fakeFs({ ...BASE });
    const runner = createFsRunner(fake.primitives);
    expect(await runner.write(request('fs_write', ['/root/proj/f']), [{ contentB64: 'aGk=', mode: null }], { roots: [ROOT] })).toEqual({ kind: 'write', ok: true });
    expect(fake.calls.truncates).toBe(1);
    expect(fake.calls.writes).toBe(1);
  });

  it('a component that is a symlink, or whose opened handle is not the inode lstat named, is refused during the walk', async () => {
    const linked = fakeFs({ ...BASE, '/root/proj': { kind: 'symlink', ino: 2 } });
    expect((await createFsRunner(linked.primitives).read(request('fs_read', ['/root/proj/f']), { roots: [ROOT], maxContentBytes: 1024 })).kind).toBe('error');
    const table = { ...BASE };
    const swapped = fakeFs(table, { onOpen: (path, flags) => { if ((flags & fsConstants.O_DIRECTORY) !== 0 && path === '/root/proj') table['/root/proj'] = { kind: 'dir', ino: 77 }; } });
    const outcome = await createFsRunner(swapped.primitives).read(request('fs_read', ['/root/proj/f']), { roots: [ROOT], maxContentBytes: 1024 });
    expect(outcome).toMatchObject({ kind: 'error', error: expect.stringMatching(/handle_mismatch/) });
    expect(swapped.calls.reads).toBe(0);
  });

  it('Linux: the final handle is additionally resolved through /proc/self/fd and must lie under the root (closes the swap-and-swap-back residual)', async () => {
    const outside = fakeFs({ ...BASE }, { platform: 'linux', procFdTarget: '/elsewhere/f' });
    const outcome = await createFsRunner(outside.primitives).read(request('fs_read', ['/root/proj/f']), { roots: [ROOT], maxContentBytes: 1024 });
    expect(outcome).toMatchObject({ kind: 'error', error: expect.stringMatching(/escaped_root/) });
    expect(outside.calls.reads).toBe(0);
    const inside = fakeFs({ ...BASE }, { platform: 'linux', procFdTarget: '/root/proj/f' });
    expect((await createFsRunner(inside.primitives).read(request('fs_read', ['/root/proj/f']), { roots: [ROOT], maxContentBytes: 1024 })).kind).toBe('read');
  });

  it('a new file: the missing final component is created (no O_TRUNC) and its ancestry is verified the same way', async () => {
    const fake = fakeFs({ ...BASE });
    fake.primitives.open = (async (path: string, flags: number, mode?: number) => {
      if (path === '/root/proj/new' && !fake.table[path]) fake.table[path] = { kind: 'file', ino: 5 };
      return (fakeFs(fake.table).primitives as FsPrimitives).open(path, flags, mode);
    }) as FsPrimitives['open'];
    expect(await createFsRunner(fake.primitives).write(request('fs_write', ['/root/proj/new']), [{ contentB64: 'aGk=', mode: 0o600 }], { roots: [ROOT] })).toEqual({ kind: 'write', ok: true });
  });

  it('P2: a file over the ceiling is refused from fstat size BEFORE any read — readFile is never called', async () => {
    const fake = fakeFs({ ...BASE, '/root/proj/f': { kind: 'file', ino: 3, size: 4096, content: 'x' } });
    expect(await createFsRunner(fake.primitives).read(request('fs_read', ['/root/proj/f']), { roots: [ROOT], maxContentBytes: 1024 })).toEqual({ kind: 'too_large', size: 4096, maxContentBytes: 1024 });
    expect(fake.calls.reads).toBe(0);
  });

  it('openVerified refuses a path outside every root before any open', async () => {
    const fake = fakeFs({ ...BASE });
    await expect(openVerified('/other/f', fsConstants.O_RDONLY, undefined, [ROOT], fake.primitives)).rejects.toThrow(/outside_root/);
    expect(fake.calls.opens).toHaveLength(0);
  });

  it('the fake and real stats agree on shape (sanity for the fake)', () => {
    const stat = statSync('/');
    expect(typeof stat.ino).toBe('number');
    expect(vi.isMockFunction(statSync)).toBe(false);
  });
});
