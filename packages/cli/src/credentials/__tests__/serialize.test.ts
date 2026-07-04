import { describe, expect, it } from 'vitest';
import {
  CredentialsFileFormatError,
  emptyCredentialsFile,
  getHost,
  isSecureMode,
  listSummaries,
  parseCredentialsFile,
  parseHostCredential,
  permissionFixItMessage,
  removeHost,
  serializeCredentialsFile,
  serializeHostCredential,
  tokenPrefix,
  upsertHost,
} from '@pagespace/cli';
import type { CredentialsFile, HostCredential } from '@pagespace/cli';

const CRED_A: HostCredential = {
  refreshToken: 'ps_rt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  clientId: 'cli-first-party',
  scopes: ['drives:read', 'drives:write'],
  createdAt: '2026-07-03T00:00:00.000Z',
};

const CRED_B: HostCredential = {
  refreshToken: 'ps_rt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  clientId: 'cli-first-party',
  scopes: ['*'],
  createdAt: '2026-07-03T01:00:00.000Z',
};

describe('emptyCredentialsFile', () => {
  it('starts with version 1 and no hosts', () => {
    expect(emptyCredentialsFile()).toEqual({ version: 1, hosts: {} });
  });
});

describe('upsertHost / getHost / removeHost', () => {
  it('is pure: does not mutate the input file', () => {
    const file = emptyCredentialsFile();
    const next = upsertHost(file, 'pagespace.ai', CRED_A);
    expect(file).toEqual({ version: 1, hosts: {} });
    expect(getHost(next, 'pagespace.ai')).toEqual(CRED_A);
  });

  it('supports multiple hosts independently', () => {
    let file = emptyCredentialsFile();
    file = upsertHost(file, 'pagespace.ai', CRED_A);
    file = upsertHost(file, 'self-hosted.example', CRED_B);
    expect(getHost(file, 'pagespace.ai')).toEqual(CRED_A);
    expect(getHost(file, 'self-hosted.example')).toEqual(CRED_B);
  });

  it('getHost returns null for an unknown host', () => {
    expect(getHost(emptyCredentialsFile(), 'unknown.example')).toBeNull();
  });

  it('removeHost drops only the named host, pure', () => {
    let file = emptyCredentialsFile();
    file = upsertHost(file, 'pagespace.ai', CRED_A);
    file = upsertHost(file, 'self-hosted.example', CRED_B);
    const next = removeHost(file, 'pagespace.ai');
    expect(getHost(next, 'pagespace.ai')).toBeNull();
    expect(getHost(next, 'self-hosted.example')).toEqual(CRED_B);
    expect(getHost(file, 'pagespace.ai')).toEqual(CRED_A);
  });

  it('removeHost on a missing host is a no-op', () => {
    const file = upsertHost(emptyCredentialsFile(), 'pagespace.ai', CRED_A);
    expect(removeHost(file, 'unknown.example')).toEqual(file);
  });
});

describe('serializeCredentialsFile / parseCredentialsFile round-trip', () => {
  it('round-trips an empty file', () => {
    const file = emptyCredentialsFile();
    expect(parseCredentialsFile(serializeCredentialsFile(file))).toEqual(file);
  });

  it('round-trips a multi-host file', () => {
    let file = emptyCredentialsFile();
    file = upsertHost(file, 'pagespace.ai', CRED_A);
    file = upsertHost(file, 'self-hosted.example', CRED_B);
    expect(parseCredentialsFile(serializeCredentialsFile(file))).toEqual(file);
  });

  it('rejects invalid JSON', () => {
    expect(() => parseCredentialsFile('{not json')).toThrow(CredentialsFileFormatError);
  });

  it('rejects an unsupported version', () => {
    expect(() => parseCredentialsFile(JSON.stringify({ version: 99, hosts: {} }))).toThrow(
      CredentialsFileFormatError,
    );
  });

  it('rejects a malformed host entry (missing refreshToken)', () => {
    const raw = JSON.stringify({
      version: 1,
      hosts: { 'pagespace.ai': { clientId: 'x', scopes: [], createdAt: '2026-01-01T00:00:00.000Z' } },
    });
    expect(() => parseCredentialsFile(raw)).toThrow(CredentialsFileFormatError);
  });

  it('rejects a host entry with non-string scopes', () => {
    const raw = JSON.stringify({
      version: 1,
      hosts: {
        'pagespace.ai': { refreshToken: 't', clientId: 'x', scopes: [1, 2], createdAt: '2026-01-01T00:00:00.000Z' },
      },
    });
    expect(() => parseCredentialsFile(raw)).toThrow(CredentialsFileFormatError);
  });
});

describe('listSummaries', () => {
  it('exposes host + tokenPrefix only, sorted by host, never the full token', () => {
    let file: CredentialsFile = emptyCredentialsFile();
    file = upsertHost(file, 'self-hosted.example', CRED_B);
    file = upsertHost(file, 'pagespace.ai', CRED_A);

    const summaries = listSummaries(file);

    expect(summaries).toEqual([
      { host: 'pagespace.ai', tokenPrefix: tokenPrefix(CRED_A.refreshToken) },
      { host: 'self-hosted.example', tokenPrefix: tokenPrefix(CRED_B.refreshToken) },
    ]);

    const serialized = JSON.stringify(summaries);
    expect(serialized).not.toContain(CRED_A.refreshToken);
    expect(serialized).not.toContain(CRED_B.refreshToken);
    expect(Object.keys(summaries[0] as object).sort()).toEqual(['host', 'tokenPrefix']);
  });
});

describe('tokenPrefix', () => {
  it('truncates to a short, non-reversible prefix', () => {
    const long = 'ps_rt_0123456789abcdefghijklmnopqrstuvwxyz';
    const prefix = tokenPrefix(long);
    expect(prefix.length).toBeLessThan(long.length);
    expect(long.startsWith(prefix)).toBe(true);
  });

  it('never grows longer than the input', () => {
    expect(tokenPrefix('short').length).toBeLessThanOrEqual('short'.length);
  });
});

describe('serializeHostCredential / parseHostCredential round-trip (keychain secret encoding)', () => {
  it('round-trips a credential', () => {
    expect(parseHostCredential(serializeHostCredential(CRED_A))).toEqual(CRED_A);
  });

  it('rejects a malformed secret', () => {
    expect(() => parseHostCredential('{"refreshToken":"x"}')).toThrow(CredentialsFileFormatError);
  });

  it('rejects non-JSON secrets', () => {
    expect(() => parseHostCredential('not json at all')).toThrow(CredentialsFileFormatError);
  });
});

describe('isSecureMode', () => {
  it('accepts 0600 (owner read/write only)', () => {
    expect(isSecureMode(0o600)).toBe(true);
  });

  it('accepts 0700 (owner-only directory)', () => {
    expect(isSecureMode(0o700)).toBe(true);
  });

  it('rejects group-readable 0640', () => {
    expect(isSecureMode(0o640)).toBe(false);
  });

  it('rejects other-readable 0604', () => {
    expect(isSecureMode(0o604)).toBe(false);
  });

  it('rejects world-writable 0666', () => {
    expect(isSecureMode(0o666)).toBe(false);
  });
});

describe('permissionFixItMessage', () => {
  it('names the offending path and a chmod fix-it, never any credential content', () => {
    const message = permissionFixItMessage('/home/user/.pagespace/credentials.json', 0o644);
    expect(message).toContain('/home/user/.pagespace/credentials.json');
    expect(message.toLowerCase()).toContain('chmod 600');
  });
});
