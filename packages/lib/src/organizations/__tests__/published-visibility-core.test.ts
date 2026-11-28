import { describe, it, expect } from 'vitest';
import { DEFAULT_ORG_POLICIES } from '../policies-core';
import {
  PARKED_PREFIX,
  PUBLISHED_PREFIX,
  movePrefix,
  parkedKeyOf,
  prefixVisible,
  publicKeyOf,
  type PublishedObjectStore,
} from '../published-visibility-core';

const policies = (over: Partial<typeof DEFAULT_ORG_POLICIES>) => ({ ...DEFAULT_ORG_POLICIES, ...over });

class MemoryStore implements PublishedObjectStore {
  objects = new Map<string, string>();
  failCopyOn: string | null = null;
  failRemoveOn: string | null = null;
  constructor(seed: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(seed)) this.objects.set(k, v);
  }
  async listKeys(prefix: string) {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
  async listPrefixes(root: string) {
    const names = new Set<string>();
    for (const k of this.objects.keys()) if (k.startsWith(root)) names.add(k.slice(root.length).split('/')[0]);
    return [...names].sort();
  }
  async exists(key: string) {
    return this.objects.has(key);
  }
  async copy(from: string, to: string) {
    if (this.failCopyOn === from) throw new Error('copy failed');
    const body = this.objects.get(from);
    if (body === undefined) throw new Error('NoSuchKey');
    this.objects.set(to, body);
  }
  async remove(key: string) {
    if (this.failRemoveOn === key) throw new Error('remove failed');
    this.objects.delete(key);
  }
}

describe('key mapping', () => {
  it('POL-4 (partial) a public key maps to its parked key and back, and only keys under the public prefix map', () => {
    expect(parkedKeyOf('published/acme/docs/index.html')).toBe('suspended/acme/docs/index.html');
    expect(publicKeyOf('suspended/acme/docs/index.html')).toBe('published/acme/docs/index.html');
    expect(parkedKeyOf('assets/abc')).toBeNull();
    expect(publicKeyOf('published/acme/x')).toBeNull();
    expect(PUBLISHED_PREFIX).not.toBe(PARKED_PREFIX);
  });
});

describe('prefixVisible', () => {
  it('POL-4 (partial) a drive site is visible only while publishing is on; a custom domain needs publishing AND custom domains', () => {
    expect(prefixVisible(policies({}), 'site')).toBe(true);
    expect(prefixVisible(policies({ publishWeb: false }), 'site')).toBe(false);
    expect(prefixVisible(policies({ customDomains: false }), 'site')).toBe(true);
    expect(prefixVisible(policies({}), 'domain')).toBe(true);
    expect(prefixVisible(policies({ customDomains: false }), 'domain')).toBe(false);
    expect(prefixVisible(policies({ publishWeb: false }), 'domain')).toBe(false);
  });

  it('POL-4 (partial) a platform-owned alias follows publishing only: the custom-domains switch is about the org\'s own domains', () => {
    expect(prefixVisible(policies({ customDomains: false }), 'platform_domain')).toBe(true);
    expect(prefixVisible(policies({ publishWeb: false }), 'platform_domain')).toBe(false);
  });

  it('POL-4 (partial) a prefix with no org policy (a personal drive) is always visible', () => {
    expect(prefixVisible(null, 'site')).toBe(true);
    expect(prefixVisible(null, 'domain')).toBe(true);
  });
});

describe('movePrefix', () => {
  const seed = () => new MemoryStore({
    'published/acme/index.html': 'home',
    'published/acme/docs/index.html': 'docs',
    'published/acme/404.html': 'nf',
    'published/other/index.html': 'other',
    'assets/abc': 'asset',
  });

  it('POL-4 (partial) parking moves every object under the prefix, loses none, and touches nothing outside it', async () => {
    const store = seed();
    const res = await movePrefix(store, 'published/acme/', 'suspended/acme/');
    expect(res).toEqual({ moved: 3, kept: 0 });
    expect([...store.objects.keys()].sort()).toEqual([
      'assets/abc',
      'published/other/index.html',
      'suspended/acme/404.html',
      'suspended/acme/docs/index.html',
      'suspended/acme/index.html',
    ]);
    expect(store.objects.get('suspended/acme/docs/index.html')).toBe('docs');
  });

  it('POL-4 (partial) restoring is the exact inverse: every byte comes back where it was', async () => {
    const store = seed();
    const before = new Map(store.objects);
    await movePrefix(store, 'published/acme/', 'suspended/acme/');
    await movePrefix(store, 'suspended/acme/', 'published/acme/');
    expect(store.objects).toEqual(before);
  });

  it('POL-4 (partial) a failed copy stops with the source intact, and a re-run finishes the job (idempotent)', async () => {
    const store = seed();
    store.failCopyOn = 'published/acme/docs/index.html';
    await expect(movePrefix(store, 'published/acme/', 'suspended/acme/')).rejects.toThrow('copy failed');
    expect(store.objects.get('published/acme/docs/index.html')).toBe('docs');
    store.failCopyOn = null;
    await movePrefix(store, 'published/acme/', 'suspended/acme/');
    expect((await store.listKeys('published/acme/')).length).toBe(0);
    expect((await store.listKeys('suspended/acme/')).length).toBe(3);
  });

  it('POL-4 (partial) a failed delete after a good copy leaves BOTH copies, never neither, and a re-run removes the source', async () => {
    const store = seed();
    store.failRemoveOn = 'published/acme/index.html';
    await expect(movePrefix(store, 'published/acme/', 'suspended/acme/')).rejects.toThrow('remove failed');
    expect(store.objects.has('published/acme/index.html')).toBe(true);
    expect(store.objects.has('suspended/acme/index.html')).toBe(true);
    store.failRemoveOn = null;
    await movePrefix(store, 'published/acme/', 'suspended/acme/');
    expect(store.objects.has('published/acme/index.html')).toBe(false);
  });

  it('POL-4 (partial) restoring never overwrites a NEWER public object: the parked copy is dropped, the live one kept', async () => {
    const store = new MemoryStore({ 'suspended/acme/index.html': 'old', 'published/acme/index.html': 'new' });
    const res = await movePrefix(store, 'suspended/acme/', 'published/acme/', { overwrite: false });
    expect(res).toEqual({ moved: 0, kept: 1 });
    expect(store.objects.get('published/acme/index.html')).toBe('new');
    expect(store.objects.has('suspended/acme/index.html')).toBe(false);
  });

  it('POL-4 (partial) an empty prefix is a no-op', async () => {
    expect(await movePrefix(new MemoryStore(), 'published/none/', 'suspended/none/')).toEqual({ moved: 0, kept: 0 });
  });
});
