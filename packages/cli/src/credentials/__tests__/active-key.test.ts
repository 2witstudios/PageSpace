import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultActiveKeysPath, FileActiveKeyStore, parseActiveKeysFile } from '@pagespace/cli';

let root: string;
let activeKeysPath: string;

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'pagespace-cli-activekeys-'));
  activeKeysPath = join(root, 'nested', 'active-keys.json');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('defaultActiveKeysPath', () => {
  it('lives in the same ~/.pagespace directory as the credential file-store fallback', () => {
    expect(defaultActiveKeysPath().endsWith(join('.pagespace', 'active-keys.json'))).toBe(true);
  });
});

describe('parseActiveKeysFile', () => {
  it('parses a plain host -> name map', () => {
    expect(parseActiveKeysFile('{"https://pagespace.ai":"agent"}')).toEqual({ 'https://pagespace.ai': 'agent' });
  });

  it('returns an empty map for invalid JSON', () => {
    expect(parseActiveKeysFile('{{{not json')).toEqual({});
  });

  it('returns an empty map for non-object JSON (arrays, strings, null)', () => {
    expect(parseActiveKeysFile('[1,2]')).toEqual({});
    expect(parseActiveKeysFile('"agent"')).toEqual({});
    expect(parseActiveKeysFile('null')).toEqual({});
  });

  it('drops non-string and empty-string entries but keeps the well-formed ones', () => {
    expect(parseActiveKeysFile('{"a":"agent","b":42,"c":null,"d":"","e":{"x":1}}')).toEqual({ a: 'agent' });
  });
});

describe('FileActiveKeyStore', () => {
  it('getActiveKey on a missing file resolves null and creates nothing', async () => {
    const store = new FileActiveKeyStore({ path: activeKeysPath });
    expect(await store.getActiveKey('https://pagespace.ai')).toBeNull();
    await expect(fs.stat(activeKeysPath)).rejects.toThrow();
  });

  it('round-trips set -> get per host, independently across hosts', async () => {
    const store = new FileActiveKeyStore({ path: activeKeysPath });
    await store.setActiveKey('https://pagespace.ai', 'agent');
    await store.setActiveKey('https://dev.example', 'ci-bot');

    expect(await store.getActiveKey('https://pagespace.ai')).toBe('agent');
    expect(await store.getActiveKey('https://dev.example')).toBe('ci-bot');
    expect(await store.getActiveKey('https://other.example')).toBeNull();
  });

  it('setActiveKey overwrites a previous activation for the same host', async () => {
    const store = new FileActiveKeyStore({ path: activeKeysPath });
    await store.setActiveKey('https://pagespace.ai', 'agent');
    await store.setActiveKey('https://pagespace.ai', 'other');
    expect(await store.getActiveKey('https://pagespace.ai')).toBe('other');
  });

  it('clearActiveKey removes only that host, and is a no-op for a host with no entry', async () => {
    const store = new FileActiveKeyStore({ path: activeKeysPath });
    await store.setActiveKey('https://pagespace.ai', 'agent');
    await store.setActiveKey('https://dev.example', 'ci-bot');

    await store.clearActiveKey('https://pagespace.ai');
    await store.clearActiveKey('https://never-set.example');

    expect(await store.getActiveKey('https://pagespace.ai')).toBeNull();
    expect(await store.getActiveKey('https://dev.example')).toBe('ci-bot');
  });

  it('a corrupt file reads as "no active key" — never a throw', async () => {
    await fs.mkdir(join(root, 'nested'), { recursive: true });
    await fs.writeFile(activeKeysPath, '{{{not json at all', 'utf8');

    const store = new FileActiveKeyStore({ path: activeKeysPath });
    expect(await store.getActiveKey('https://pagespace.ai')).toBeNull();
  });

  it('a set after a corrupt file replaces it with a clean map', async () => {
    await fs.mkdir(join(root, 'nested'), { recursive: true });
    await fs.writeFile(activeKeysPath, 'garbage', 'utf8');

    const store = new FileActiveKeyStore({ path: activeKeysPath });
    await store.setActiveKey('https://pagespace.ai', 'agent');

    expect(await store.getActiveKey('https://pagespace.ai')).toBe('agent');
    expect(parseActiveKeysFile(await fs.readFile(activeKeysPath, 'utf8'))).toEqual({ 'https://pagespace.ai': 'agent' });
  });

  it('stores names only — the file never contains secret material beyond what the caller passes as a NAME', async () => {
    const store = new FileActiveKeyStore({ path: activeKeysPath });
    await store.setActiveKey('https://pagespace.ai', 'agent');
    const raw = await fs.readFile(activeKeysPath, 'utf8');
    expect(JSON.parse(raw)).toEqual({ 'https://pagespace.ai': 'agent' });
  });

  it('a "__proto__" host is ordinary data, never an Object.prototype lookup', async () => {
    const store = new FileActiveKeyStore({ path: activeKeysPath });
    expect(await store.getActiveKey('__proto__')).toBeNull();
    expect(await store.getActiveKey('toString')).toBeNull();
  });
});
