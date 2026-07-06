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
