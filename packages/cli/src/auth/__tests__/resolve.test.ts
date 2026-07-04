import { describe, expect, it } from 'vitest';
import { missingCredentialsMessage, resolveAuth } from '../resolve.js';
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
    const profiles = { [HOST]: CREDENTIAL };
    expect(resolveAuth({ token: 'mcp_flag' }, { PAGESPACE_TOKEN: 'mcp_env' }, profiles, HOST)).toEqual({
      kind: 'flag',
      token: 'mcp_flag',
    });
  });

  it('env alone -> env', () => {
    expect(resolveAuth({}, { PAGESPACE_TOKEN: 'mcp_env' }, {}, HOST)).toEqual({ kind: 'env', token: 'mcp_env' });
  });

  it('env beats a stored profile for the same host', () => {
    const profiles = { [HOST]: CREDENTIAL };
    expect(resolveAuth({}, { PAGESPACE_TOKEN: 'mcp_env' }, profiles, HOST)).toEqual({ kind: 'env', token: 'mcp_env' });
  });

  it('profile alone (host matches) -> profile', () => {
    const profiles = { [HOST]: CREDENTIAL };
    expect(resolveAuth({}, {}, profiles, HOST)).toEqual({ kind: 'profile', host: HOST, credential: CREDENTIAL });
  });

  it('nothing present -> none', () => {
    expect(resolveAuth({}, {}, {}, HOST)).toEqual({ kind: 'none', host: HOST });
  });

  it('a profile stored for a DIFFERENT host never leaks in (host-profile mismatch) -> none', () => {
    const profiles = { [OTHER_HOST]: CREDENTIAL };
    expect(resolveAuth({}, {}, profiles, HOST)).toEqual({ kind: 'none', host: HOST });
  });

  it('multiple stored profiles: only the one matching the resolved host is used', () => {
    const other: HostCredential = { ...CREDENTIAL, refreshToken: 'ps_rt_other_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' };
    const profiles = { [HOST]: CREDENTIAL, [OTHER_HOST]: other };
    expect(resolveAuth({}, {}, profiles, HOST)).toEqual({ kind: 'profile', host: HOST, credential: CREDENTIAL });
    expect(resolveAuth({}, {}, profiles, OTHER_HOST)).toEqual({ kind: 'profile', host: OTHER_HOST, credential: other });
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
    const profiles = { [HOST]: CREDENTIAL };
    expect(resolveAuth({}, { PAGESPACE_TOKEN: '\n\t' }, profiles, HOST)).toEqual({
      kind: 'profile',
      host: HOST,
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

describe('missingCredentialsMessage', () => {
  it('names all three provision options and the host, with no secret material', () => {
    const message = missingCredentialsMessage(HOST);
    expect(message).toContain('--token');
    expect(message).toContain('PAGESPACE_TOKEN');
    expect(message).toContain('pagespace login');
    expect(message).toContain(HOST);
  });
});
