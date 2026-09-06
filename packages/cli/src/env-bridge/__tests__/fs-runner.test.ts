import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, symlinkSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedRequest } from '@pagespace/lib/env-bridge/decide-execution';
import { createFsRunner, checkOpenHandle, type FsPrimitives, type OpenHandle } from '../fs-runner.js';

function request(op: 'fs_read' | 'fs_write', paths: string[]): NormalizedRequest {
  return { op, cwd: '/', paths, env: {}, timeoutMs: 1_000, maxBytes: 1_048_576, clamped: false };
}

const root = realpathSync(mkdtempSync(join(tmpdir(), 'ps-fs-runner-')));

describe('fs-runner (Codex C9: open via the confined path, then re-check the OPEN handle — pathname checks alone are TOCTOU)', () => {
  const runner = createFsRunner();

  it('given one confined path that exists, should read it back base64', async () => {
    const file = join(root, 'a.txt');
    writeFileSync(file, 'hello');
    const outcome = await runner.read(request('fs_read', [file]));
    expect(outcome).toEqual({ kind: 'read', found: true, contentB64: Buffer.from('hello').toString('base64') });
  });

  it('given a path that does not exist, should answer found:false', async () => {
    expect(await runner.read(request('fs_read', [join(root, 'missing')]))).toEqual({ kind: 'read', found: false });
  });

  it('given more than one path, should refuse as unsupported — the fs_read_result frame carries ONE content', async () => {
    expect(await runner.read(request('fs_read', [join(root, 'a.txt'), join(root, 'b.txt')]))).toEqual({ kind: 'unsupported', reason: 'multi_path_read' });
  });

  it('given a symlink at the final component (swapped in after confinement), O_NOFOLLOW must refuse to open it — never follow it', async () => {
    writeFileSync(join(root, 'secret'), 'top');
    symlinkSync(join(root, 'secret'), join(root, 'link'));
    const outcome = await runner.read(request('fs_read', [join(root, 'link')]));
    expect(outcome.kind).toBe('error');
  });

  it('given a directory where a file was expected, should fail closed (the handle re-check refuses a non-regular file)', async () => {
    mkdirSync(join(root, 'dir'));
    const outcome = await runner.read(request('fs_read', [join(root, 'dir')]));
    expect(outcome.kind).toBe('error');
  });

  it('given a write, should create the file with the requested mode via O_NOFOLLOW|O_CREAT|O_TRUNC and answer ok', async () => {
    const file = join(root, 'new.txt');
    const outcome = await runner.write(request('fs_write', [file]), [{ contentB64: Buffer.from('written').toString('base64'), mode: 0o600 }]);
    expect(outcome).toEqual({ kind: 'write', ok: true });
    expect(readFileSync(file, 'utf8')).toBe('written');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('given a write whose target is a symlink, should refuse (O_NOFOLLOW) and answer ok:false with the error — nothing written through the link', async () => {
    writeFileSync(join(root, 'target'), 'keep');
    symlinkSync(join(root, 'target'), join(root, 'wlink'));
    const outcome = await runner.write(request('fs_write', [join(root, 'wlink')]), [{ contentB64: Buffer.from('evil').toString('base64'), mode: null }]);
    expect(outcome).toMatchObject({ kind: 'write', ok: false });
    expect(readFileSync(join(root, 'target'), 'utf8')).toBe('keep');
  });

  it('given a files list whose length differs from the confined paths, should refuse before touching the disk', async () => {
    const outcome = await runner.write(request('fs_write', [join(root, 'x')]), []);
    expect(outcome).toEqual({ kind: 'write', ok: false, error: 'files/paths length mismatch' });
  });

  it('RUNNER-LEVEL C9: given primitives where the inode at the path changes after open, read() must answer error and never read the handle', async () => {
    let reads = 0;
    const handle: OpenHandle = { stat: async () => ({ dev: 1, ino: 100, isFile: () => true }), readFile: async () => { reads += 1; return Buffer.from('secret'); }, writeFile: async () => undefined, close: async () => undefined };
    const swapped = createFsRunner({ open: async () => handle, lstat: async () => ({ dev: 1, ino: 200, isFile: () => true, isSymbolicLink: () => false }) });
    const outcome = await swapped.read(request('fs_read', ['/root/f']));
    expect(outcome.kind).toBe('error');
    expect(reads).toBe(0);
    const writes = await swapped.write(request('fs_write', ['/root/f']), [{ contentB64: 'aGk=', mode: null }]);
    expect(writes).toMatchObject({ kind: 'write', ok: false });
  });

  it('given a fake filesystem where the inode at the path changes between open and re-check, checkOpenHandle must refuse', async () => {
    const handle: OpenHandle = { stat: async () => ({ dev: 1, ino: 100, isFile: () => true }), readFile: async () => Buffer.from(''), writeFile: async () => undefined, close: async () => undefined };
    const primitives: FsPrimitives = { open: async () => handle, lstat: async () => ({ dev: 1, ino: 200, isFile: () => true, isSymbolicLink: () => false }) };
    await expect(checkOpenHandle(handle, '/p', primitives)).resolves.toEqual({ ok: false, reason: 'handle_mismatch' });
  });

  it('given a fake filesystem where the path is now a symlink (lstat), checkOpenHandle must refuse even if dev/ino agree', async () => {
    const handle: OpenHandle = { stat: async () => ({ dev: 1, ino: 100, isFile: () => true }), readFile: async () => Buffer.from(''), writeFile: async () => undefined, close: async () => undefined };
    const primitives: FsPrimitives = { open: async () => handle, lstat: async () => ({ dev: 1, ino: 100, isFile: () => false, isSymbolicLink: () => true }) };
    await expect(checkOpenHandle(handle, '/p', primitives)).resolves.toEqual({ ok: false, reason: 'symlink' });
  });

  it('cleanup', () => {
    rmSync(root, { recursive: true, force: true });
  });
});
