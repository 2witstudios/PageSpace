import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileCredentialStore, PermissionError } from '@pagespace/cli';
import type { HostCredential } from '@pagespace/cli';

const CRED_A: HostCredential = {
  refreshToken: 'ps_rt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  clientId: 'cli-first-party',
  scopes: ['drives:read'],
  createdAt: '2026-07-03T00:00:00.000Z',
};

const CRED_B: HostCredential = {
  refreshToken: 'ps_rt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  clientId: 'cli-first-party',
  scopes: ['*'],
  createdAt: '2026-07-03T01:00:00.000Z',
};

let root: string;
let credentialsPath: string;

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'pagespace-cli-credstore-'));
  credentialsPath = join(root, 'nested', 'credentials.json');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function mode(stat: { mode: number }): number {
  return stat.mode & 0o777;
}

describe('FileCredentialStore', () => {
  it('get() on a missing file returns null and creates nothing', async () => {
    const store = new FileCredentialStore({ path: credentialsPath });
    expect(await store.get('pagespace.ai')).toBeNull();
    await expect(fs.stat(credentialsPath)).rejects.toThrow();
  });

  it('list() on a missing file returns an empty array', async () => {
    const store = new FileCredentialStore({ path: credentialsPath });
    expect(await store.list()).toEqual([]);
  });

  it('round-trips a single host credential', async () => {
    const store = new FileCredentialStore({ path: credentialsPath });
    await store.set('pagespace.ai', CRED_A);
    expect(await store.get('pagespace.ai')).toEqual(CRED_A);
  });

  it('creates the parent directory at 0700 and the file at 0600', async () => {
    const store = new FileCredentialStore({ path: credentialsPath });
    await store.set('pagespace.ai', CRED_A);

    const dirStat = await fs.stat(join(root, 'nested'));
    const fileStat = await fs.stat(credentialsPath);
    expect(mode(dirStat)).toBe(0o700);
    expect(mode(fileStat)).toBe(0o600);
  });

  it('writes atomically: no leftover temp file, valid JSON at the final path', async () => {
    const store = new FileCredentialStore({ path: credentialsPath });
    await store.set('pagespace.ai', CRED_A);
    await store.set('pagespace.ai', CRED_B);

    const entries = await fs.readdir(join(root, 'nested'));
    expect(entries).toEqual(['credentials.json']);

    const raw = await fs.readFile(credentialsPath, 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('supports multiple hosts independently', async () => {
    const store = new FileCredentialStore({ path: credentialsPath });
    await store.set('pagespace.ai', CRED_A);
    await store.set('self-hosted.example', CRED_B);

    expect(await store.get('pagespace.ai')).toEqual(CRED_A);
    expect(await store.get('self-hosted.example')).toEqual(CRED_B);

    const summaries = await store.list();
    expect(summaries).toHaveLength(2);
    expect(summaries.map((entry) => entry.host).sort()).toEqual(['pagespace.ai', 'self-hosted.example']);
  });

  it('delete() removes only the named host', async () => {
    const store = new FileCredentialStore({ path: credentialsPath });
    await store.set('pagespace.ai', CRED_A);
    await store.set('self-hosted.example', CRED_B);

    await store.delete('pagespace.ai');

    expect(await store.get('pagespace.ai')).toBeNull();
    expect(await store.get('self-hosted.example')).toEqual(CRED_B);
  });

  it('delete() of an unknown host is a no-op, not an error', async () => {
    const store = new FileCredentialStore({ path: credentialsPath });
    await store.set('pagespace.ai', CRED_A);
    await expect(store.delete('unknown.example')).resolves.toBeUndefined();
    expect(await store.get('pagespace.ai')).toEqual(CRED_A);
  });

  it('list() never includes token material, only host + prefix', async () => {
    const store = new FileCredentialStore({ path: credentialsPath });
    await store.set('pagespace.ai', CRED_A);

    const serialized = JSON.stringify(await store.list());
    expect(serialized).not.toContain(CRED_A.refreshToken);
    expect(serialized).toContain('pagespace.ai');
  });

  it('refuses to read a group-readable credentials file (fail closed)', async () => {
    const store = new FileCredentialStore({ path: credentialsPath });
    await store.set('pagespace.ai', CRED_A);
    await fs.chmod(credentialsPath, 0o640);

    await expect(store.get('pagespace.ai')).rejects.toThrow(PermissionError);
    await expect(store.list()).rejects.toThrow(PermissionError);
  });

  it('refuses to read an other-readable credentials file (fail closed)', async () => {
    const store = new FileCredentialStore({ path: credentialsPath });
    await store.set('pagespace.ai', CRED_A);
    await fs.chmod(credentialsPath, 0o604);

    await expect(store.get('pagespace.ai')).rejects.toThrow(PermissionError);
  });

  it('permission error message names the file and a chmod fix-it, no token content', async () => {
    const store = new FileCredentialStore({ path: credentialsPath });
    await store.set('pagespace.ai', CRED_A);
    await fs.chmod(credentialsPath, 0o644);

    await expect(store.get('pagespace.ai')).rejects.toThrow(/chmod 600/i);
    try {
      await store.get('pagespace.ai');
      expect.unreachable();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain(credentialsPath);
      expect(message).not.toContain(CRED_A.refreshToken);
    }
  });

  it('checks permissions and reads via the same open file descriptor, not stat-then-open-by-path (TOCTOU)', async () => {
    const store = new FileCredentialStore({ path: credentialsPath });
    await store.set('pagespace.ai', CRED_A);

    // The old implementation called fs.stat(path) directly, then a separate
    // fs.readFile(path) — a check-to-use gap an attacker could exploit by
    // swapping the path's target between the two calls. The fix opens the
    // file once and stats/reads that same descriptor, so a path-level
    // fs.stat should never be invoked from readFile().
    const statSpy = vi.spyOn(fs, 'stat');
    try {
      expect(await store.get('pagespace.ai')).toEqual(CRED_A);
      expect(statSpy).not.toHaveBeenCalled();
    } finally {
      statSpy.mockRestore();
    }
  });

  it('re-secures a permissive parent directory on every write (floor enforced both directions)', async () => {
    const store = new FileCredentialStore({ path: credentialsPath });
    await store.set('pagespace.ai', CRED_A);
    await fs.chmod(join(root, 'nested'), 0o755);

    await store.set('pagespace.ai', CRED_B);

    const dirStat = await fs.stat(join(root, 'nested'));
    expect(mode(dirStat)).toBe(0o700);
  });
});
