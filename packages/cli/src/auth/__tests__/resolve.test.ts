import { describe, expect, it } from 'vitest';
import { missingCredentialsMessage, resolveAuth, resolveProfileName } from '../resolve.js';
import type { HostCredential } from '../../credentials/serialize.js';

const HOST = 'https://pagespace.ai';
const OTHER_HOST = 'https://self-hosted.example';

const CREDENTIAL: HostCredential = {
  refreshToken: 'ps_rt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  clientId: 'pagespace-cli',
  scopes: ['account', 'offline_access'],
  createdAt: '2026-07-03T00:00:00.000Z',
};

describe('resolveAuth — precedence table', () => {
  it('flag alone -> flag', () => {
    expect(resolveAuth({ token: 'mcp_flag' }, {}, {}, HOST)).toEqual({ kind: 'flag', token: 'mcp_flag' });
  });

  it('flag beats env', () => {
    expect(resolveAuth({ token: 'mcp_flag' }, { PAGESPACE_TOKEN: 'mcp_env' }, {}, HOST)).toEqual({
      kind: 'flag',
      token: 'mcp_flag',
    });
  });

  it('flag beats env and profile all present at once', () => {
    const profiles = { [HOST]: { default: CREDENTIAL } };
    expect(resolveAuth({ token: 'mcp_flag' }, { PAGESPACE_TOKEN: 'mcp_env' }, profiles, HOST)).toEqual({
      kind: 'flag',
      token: 'mcp_flag',
    });
  });

  it('env alone -> env', () => {
    expect(resolveAuth({}, { PAGESPACE_TOKEN: 'mcp_env' }, {}, HOST)).toEqual({ kind: 'env', token: 'mcp_env' });
  });

  it('env beats a stored profile for the same host', () => {
    const profiles = { [HOST]: { default: CREDENTIAL } };
    expect(resolveAuth({}, { PAGESPACE_TOKEN: 'mcp_env' }, profiles, HOST)).toEqual({ kind: 'env', token: 'mcp_env' });
  });

  it('profile alone (host matches) -> profile', () => {
    const profiles = { [HOST]: { default: CREDENTIAL } };
    expect(resolveAuth({}, {}, profiles, HOST)).toEqual({
      kind: 'profile',
      host: HOST,
      profileName: 'default',
      credential: CREDENTIAL,
    });
  });

  it('nothing present -> none', () => {
    expect(resolveAuth({}, {}, {}, HOST)).toEqual({ kind: 'none', host: HOST });
  });

  it('a profile stored for a DIFFERENT host never leaks in (host-profile mismatch) -> none', () => {
    const profiles = { [OTHER_HOST]: { default: CREDENTIAL } };
    expect(resolveAuth({}, {}, profiles, HOST)).toEqual({ kind: 'none', host: HOST });
  });

  it('multiple stored profiles: only the one matching the resolved host is used', () => {
    const other: HostCredential = { ...CREDENTIAL, refreshToken: 'ps_rt_other_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' };
    const profiles = { [HOST]: { default: CREDENTIAL }, [OTHER_HOST]: { default: other } };
    expect(resolveAuth({}, {}, profiles, HOST)).toEqual({
      kind: 'profile',
      host: HOST,
      profileName: 'default',
      credential: CREDENTIAL,
    });
    expect(resolveAuth({}, {}, profiles, OTHER_HOST)).toEqual({
      kind: 'profile',
      host: OTHER_HOST,
      profileName: 'default',
      credential: other,
    });
  });

  it('an empty-string flag token is absent, falls through to env', () => {
    expect(resolveAuth({ token: '' }, { PAGESPACE_TOKEN: 'mcp_env' }, {}, HOST)).toEqual({
      kind: 'env',
      token: 'mcp_env',
    });
  });

  it('a whitespace-only flag token is absent, falls through to env', () => {
    expect(resolveAuth({ token: '   ' }, { PAGESPACE_TOKEN: 'mcp_env' }, {}, HOST)).toEqual({
      kind: 'env',
      token: 'mcp_env',
    });
  });

  it('a whitespace-only env token is absent, falls through to the stored profile', () => {
    const profiles = { [HOST]: { default: CREDENTIAL } };
    expect(resolveAuth({}, { PAGESPACE_TOKEN: '\n\t' }, profiles, HOST)).toEqual({
      kind: 'profile',
      host: HOST,
      profileName: 'default',
      credential: CREDENTIAL,
    });
  });

  it('trims surrounding whitespace from a winning flag token', () => {
    expect(resolveAuth({ token: '  mcp_flag  \n' }, {}, {}, HOST)).toEqual({ kind: 'flag', token: 'mcp_flag' });
  });

  it('trims surrounding whitespace from a winning env token', () => {
    expect(resolveAuth({}, { PAGESPACE_TOKEN: '  mcp_env\n' }, {}, HOST)).toEqual({ kind: 'env', token: 'mcp_env' });
  });
});

describe('resolveAuth — named profiles (Phase 8 task 3)', () => {
  const WORK_CREDENTIAL: HostCredential = { ...CREDENTIAL, refreshToken: 'ps_rt_work_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' };

  it('resolves the credential stored under the given profile name, keyed one level deeper than host', () => {
    const profiles = { [HOST]: { default: CREDENTIAL, work: WORK_CREDENTIAL } };
    expect(resolveAuth({}, {}, profiles, HOST, 'work')).toEqual({
      kind: 'profile',
      host: HOST,
      profileName: 'work',
      credential: WORK_CREDENTIAL,
    });
  });

  it('defaults to the "default" profile name when none is given', () => {
    const profiles = { [HOST]: { default: CREDENTIAL, work: WORK_CREDENTIAL } };
    expect(resolveAuth({}, {}, profiles, HOST)).toEqual({
      kind: 'profile',
      host: HOST,
      profileName: 'default',
      credential: CREDENTIAL,
    });
  });

  it('a host with only a non-default profile never leaks in under a different profile name -> none', () => {
    const profiles = { [HOST]: { work: WORK_CREDENTIAL } };
    expect(resolveAuth({}, {}, profiles, HOST, 'default')).toEqual({ kind: 'none', host: HOST });
  });

  it('an unknown profile name on a host with other profiles stored -> none', () => {
    const profiles = { [HOST]: { default: CREDENTIAL } };
    expect(resolveAuth({}, {}, profiles, HOST, 'nonexistent')).toEqual({ kind: 'none', host: HOST });
  });
});

describe('resolveProfileName — precedence table', () => {
  it('flag alone -> flag value', () => {
    expect(resolveProfileName({ profile: 'work' }, {})).toBe('work');
  });

  it('flag beats env', () => {
    expect(resolveProfileName({ profile: 'work' }, { PAGESPACE_PROFILE: 'personal' })).toBe('work');
  });

  it('env alone -> env value', () => {
    expect(resolveProfileName({}, { PAGESPACE_PROFILE: 'personal' })).toBe('personal');
  });

  it('nothing present -> "default"', () => {
    expect(resolveProfileName({}, {})).toBe('default');
  });

  it('an empty-string flag is absent, falls through to env', () => {
    expect(resolveProfileName({ profile: '' }, { PAGESPACE_PROFILE: 'personal' })).toBe('personal');
  });

  it('a whitespace-only env value is absent, falls through to "default"', () => {
    expect(resolveProfileName({}, { PAGESPACE_PROFILE: '   ' })).toBe('default');
  });

  it('trims surrounding whitespace from a winning flag value', () => {
    expect(resolveProfileName({ profile: '  work  \n' }, {})).toBe('work');
  });
});

describe('missingCredentialsMessage', () => {
  it('names all three provision options and the host, with no secret material', () => {
    const message = missingCredentialsMessage(HOST);
    expect(message).toContain('--token');
    expect(message).toContain('PAGESPACE_TOKEN');
    expect(message).toContain('pagespace login');
    expect(message).toContain(HOST);
  });
});
