import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CompositeCredentialStore, FileCredentialStore } from '@pagespace/cli';
import type { HostCredential, OutputSink } from '@pagespace/cli';
import { createFakeKeychainAdapter, createUnavailableKeychainAdapter } from './fake-keychain.js';

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

function fakeSink(): OutputSink & { readonly lines: string[] } {
  const lines: string[] = [];
  return { lines, write: (chunk: string) => lines.push(chunk) };
}

let root: string;
let credentialsPath: string;

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'pagespace-cli-credstore-composite-'));
  credentialsPath = join(root, 'credentials.json');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('CompositeCredentialStore — keychain available', () => {
  it('uses the keychain and never touches the file store', async () => {
    const keychain = createFakeKeychainAdapter();
    const fileStore = new FileCredentialStore({ path: credentialsPath });
    const stderr = fakeSink();
    const store = new CompositeCredentialStore(keychain, fileStore, stderr);

    await store.set('pagespace.ai', CRED_A);
    const got = await store.get('pagespace.ai');

    expect(got).toEqual(CRED_A);
    expect(keychain.calls).toContain('setSecret:pagespace.ai');
    await expect(fs.stat(credentialsPath)).rejects.toThrow();
    expect(stderr.lines).toEqual([]);
  });

  it('list() never exposes token material', async () => {
    const keychain = createFakeKeychainAdapter();
    const store = new CompositeCredentialStore(keychain, new FileCredentialStore({ path: credentialsPath }), fakeSink());

    await store.set('pagespace.ai', CRED_A);
    await store.set('self-hosted.example', CRED_B);

    const summaries = await store.list();
    expect(summaries.map((entry) => entry.host).sort()).toEqual(['pagespace.ai', 'self-hosted.example']);

    const serialized = JSON.stringify(summaries);
    expect(serialized).not.toContain(CRED_A.refreshToken);
    expect(serialized).not.toContain(CRED_B.refreshToken);
  });

  it('delete() removes from the keychain', async () => {
    const keychain = createFakeKeychainAdapter();
    const store = new CompositeCredentialStore(keychain, new FileCredentialStore({ path: credentialsPath }), fakeSink());

    await store.set('pagespace.ai', CRED_A);
    await store.delete('pagespace.ai');

    expect(await store.get('pagespace.ai')).toBeNull();
  });

  describe('named profiles', () => {
    it('stores a named profile under a distinct keychain account key, coexisting with "default"', async () => {
      const keychain = createFakeKeychainAdapter();
      const store = new CompositeCredentialStore(keychain, new FileCredentialStore({ path: credentialsPath }), fakeSink());

      await store.set('pagespace.ai', CRED_A);
      await store.set('pagespace.ai', CRED_B, 'work');

      expect(await store.get('pagespace.ai')).toEqual(CRED_A);
      expect(await store.get('pagespace.ai', 'work')).toEqual(CRED_B);
      expect(keychain.calls).toContain('setSecret:pagespace.ai');
      expect(keychain.calls.some((call) => call.startsWith('setSecret:') && call !== 'setSecret:pagespace.ai')).toBe(true);
    });

    it('list(profile) only reports hosts with that profile stored', async () => {
      const keychain = createFakeKeychainAdapter();
      const store = new CompositeCredentialStore(keychain, new FileCredentialStore({ path: credentialsPath }), fakeSink());

      await store.set('pagespace.ai', CRED_A);
      await store.set('pagespace.ai', CRED_B, 'work');
      await store.set('self-hosted.example', CRED_B);

      expect((await store.list()).map((entry) => entry.host).sort()).toEqual(['pagespace.ai', 'self-hosted.example']);
      expect(await store.list('work')).toEqual([{ host: 'pagespace.ai', tokenPrefix: CRED_B.refreshToken.slice(0, 12) }]);
    });

    it('delete(host, profile) removes only the named profile, leaving "default" intact', async () => {
      const keychain = createFakeKeychainAdapter();
      const store = new CompositeCredentialStore(keychain, new FileCredentialStore({ path: credentialsPath }), fakeSink());

      await store.set('pagespace.ai', CRED_A);
      await store.set('pagespace.ai', CRED_B, 'work');

      await store.delete('pagespace.ai', 'work');

      expect(await store.get('pagespace.ai', 'work')).toBeNull();
      expect(await store.get('pagespace.ai')).toEqual(CRED_A);
    });
  });
});

describe('CompositeCredentialStore — NUL-byte host/profile rejection', () => {
  it('rejects a NUL byte in host at the boundary rather than silently degrading to the file store', async () => {
    const keychain = createFakeKeychainAdapter();
    const fileStore = new FileCredentialStore({ path: credentialsPath });
    const store = new CompositeCredentialStore(keychain, fileStore, fakeSink());

    await expect(store.set('A\u0000B', CRED_A, 'C')).rejects.toThrow(/NUL/);
    await expect(fileStore.get('A\u0000B', 'C')).resolves.toBeNull();
  });

  it('rejects a NUL byte in profile at the boundary rather than silently degrading to the file store', async () => {
    const keychain = createFakeKeychainAdapter();
    const fileStore = new FileCredentialStore({ path: credentialsPath });
    const store = new CompositeCredentialStore(keychain, fileStore, fakeSink());

    await expect(store.set('A', CRED_A, 'B\u0000C')).rejects.toThrow(/NUL/);
    await expect(fileStore.get('A', 'B\u0000C')).resolves.toBeNull();
  });

  it('rejects a NUL byte in host even when the keychain is already degraded and every call goes straight to the file store', async () => {
    const keychain = createUnavailableKeychainAdapter();
    const fileStore = new FileCredentialStore({ path: credentialsPath });
    const store = new CompositeCredentialStore(keychain, fileStore, fakeSink());

    // Degrade the store first via an unrelated, valid host.
    await store.set('pagespace.ai', CRED_A);

    await expect(store.set('A\u0000B', CRED_A, 'C')).rejects.toThrow(/NUL/);
    await expect(fileStore.get('A\u0000B', 'C')).resolves.toBeNull();
  });

  it('rejects a NUL byte on get() and delete(), not just set()', async () => {
    const keychain = createFakeKeychainAdapter();
    const fileStore = new FileCredentialStore({ path: credentialsPath });
    const store = new CompositeCredentialStore(keychain, fileStore, fakeSink());

    await expect(store.get('A\u0000B', 'C')).rejects.toThrow(/NUL/);
    await expect(store.delete('A\u0000B', 'C')).rejects.toThrow(/NUL/);
  });
});

describe('CompositeCredentialStore — malformed keychain entry', () => {
  it('get() throws a distinct, accurately-worded error for a malformed entry, without degrading the store', async () => {
    const keychain = createFakeKeychainAdapter();
    const fileStore = new FileCredentialStore({ path: credentialsPath });
    const stderr = fakeSink();
    const store = new CompositeCredentialStore(keychain, fileStore, stderr);

    await store.set('pagespace.ai', CRED_A);
    await keychain.setSecret('bad.example', 'not-valid-json');

    await expect(store.get('bad.example')).rejects.toThrow(/malformed/i);
    await expect(store.get('bad.example')).rejects.not.toThrow(/keychain unavailable/i);

    // The store must still be using the keychain for other hosts, not degraded to the file store.
    expect(await store.get('pagespace.ai')).toEqual(CRED_A);
    expect(stderr.lines).toEqual([]);
    await expect(fs.stat(credentialsPath)).rejects.toThrow();
  });

  it('list() skips a malformed entry with a stderr warning instead of throwing or degrading the whole store', async () => {
    const keychain = createFakeKeychainAdapter();
    const stderr = fakeSink();
    const store = new CompositeCredentialStore(keychain, new FileCredentialStore({ path: credentialsPath }), stderr);

    await store.set('pagespace.ai', CRED_A);
    await keychain.setSecret('bad.example', 'not-valid-json');

    const summaries = await store.list();

    expect(summaries).toEqual([{ host: 'pagespace.ai', tokenPrefix: CRED_A.refreshToken.slice(0, 12) }]);
    expect(stderr.lines.join('')).toMatch(/bad\.example/);
    expect(stderr.lines.join('')).not.toMatch(/keychain unavailable/i);
    expect(stderr.lines.join('')).not.toContain(CRED_A.refreshToken);

    // Still on the keychain afterward — one bad entry must not flip the whole store to the file-store fallback.
    expect(await store.get('pagespace.ai')).toEqual(CRED_A);
    expect(keychain.calls).toContain('getSecret:pagespace.ai');
  });
});

describe('CompositeCredentialStore — keychain unavailable', () => {
  it('degrades to the file store and prints exactly one stderr notice', async () => {
    const keychain = createUnavailableKeychainAdapter('no secret service running');
    const fileStore = new FileCredentialStore({ path: credentialsPath });
    const stderr = fakeSink();
    const store = new CompositeCredentialStore(keychain, fileStore, stderr);

    await store.set('pagespace.ai', CRED_A);
    const got = await store.get('pagespace.ai');
    await store.list();

    expect(got).toEqual(CRED_A);
    expect(await fileStore.get('pagespace.ai')).toEqual(CRED_A);
    expect(stderr.lines).toHaveLength(1);
    expect(stderr.lines[0]).toMatch(/keychain unavailable/i);
  });

  it('stops calling the keychain after the first failure (degrade is sticky)', async () => {
    const keychain = createUnavailableKeychainAdapter();
    const store = new CompositeCredentialStore(keychain, new FileCredentialStore({ path: credentialsPath }), fakeSink());

    await store.set('pagespace.ai', CRED_A);
    await store.get('pagespace.ai');
    await store.list();

    expect(keychain.calls).toEqual(['setSecret:pagespace.ai']);
  });

  it('never crashes the caller — falls back transparently', async () => {
    const keychain = createUnavailableKeychainAdapter();
    const store = new CompositeCredentialStore(keychain, new FileCredentialStore({ path: credentialsPath }), fakeSink());

    await expect(store.set('pagespace.ai', CRED_A)).resolves.toBeUndefined();
    await expect(store.get('pagespace.ai')).resolves.toEqual(CRED_A);
  });

  it('never puts token material in the stderr notice', async () => {
    const keychain = createUnavailableKeychainAdapter();
    const stderr = fakeSink();
    const store = new CompositeCredentialStore(keychain, new FileCredentialStore({ path: credentialsPath }), stderr);

    await store.set('pagespace.ai', CRED_A);

    expect(stderr.lines.join('')).not.toContain(CRED_A.refreshToken);
  });
});
