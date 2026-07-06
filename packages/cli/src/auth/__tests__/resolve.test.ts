import { describe, expect, it } from 'vitest';
import { hasExplicitCredential, missingCredentialsMessage, noExplicitCredentialMessage, resolveAuth, resolveProfileName } from '../resolve.js';
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

describe('resolveAuth — prototype-named profiles are ordinary data, never Object.prototype lookups', () => {
  const PROTOTYPE_NAMES = ['__proto__', 'constructor', 'toString'] as const;

  it('a prototype-named profile that was never stored resolves to none, not a bogus Object.prototype credential', () => {
    const profiles = { [HOST]: { default: CREDENTIAL } };
    for (const name of PROTOTYPE_NAMES) {
      expect(resolveAuth({}, {}, profiles, HOST, name)).toEqual({ kind: 'none', host: HOST });
    }
  });

  it('a prototype-named profile that was never stored resolves to none even with no profiles for the host at all', () => {
    for (const name of PROTOTYPE_NAMES) {
      expect(resolveAuth({}, {}, {}, HOST, name)).toEqual({ kind: 'none', host: HOST });
    }
  });

  it('stores and resolves a genuinely prototype-named profile like any other name', () => {
    for (const name of PROTOTYPE_NAMES) {
      const profiles = { [HOST]: { [name]: CREDENTIAL } };
      expect(resolveAuth({}, {}, profiles, HOST, name)).toEqual({
        kind: 'profile',
        host: HOST,
        profileName: name,
        credential: CREDENTIAL,
      });
    }
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

describe('hasExplicitCredential — pagespace mcp fail-closed gate (Phase 8 task 4)', () => {
  it('nothing present -> false (the case mcp must refuse)', () => {
    expect(hasExplicitCredential({}, {})).toBe(false);
  });

  it('--token flag alone -> true', () => {
    expect(hasExplicitCredential({ token: 'mcp_flag' }, {})).toBe(true);
  });

  it('PAGESPACE_TOKEN env alone -> true', () => {
    expect(hasExplicitCredential({}, { PAGESPACE_TOKEN: 'mcp_env' })).toBe(true);
  });

  it('--profile flag alone -> true, even with no matching stored credential', () => {
    expect(hasExplicitCredential({ profile: 'agent' }, {})).toBe(true);
  });

  it('PAGESPACE_PROFILE env alone -> true', () => {
    expect(hasExplicitCredential({}, { PAGESPACE_PROFILE: 'agent' })).toBe(true);
  });

  it('an explicit --profile "default" still counts as explicit — the user named it, not the resolver', () => {
    expect(hasExplicitCredential({ profile: 'default' }, {})).toBe(true);
  });

  it('a whitespace-only --token flag is absent, same as resolveAuth', () => {
    expect(hasExplicitCredential({ token: '   ' }, {})).toBe(false);
  });

  it('a whitespace-only --profile flag is absent, same as resolveProfileName', () => {
    expect(hasExplicitCredential({ profile: '\n\t' }, {})).toBe(false);
  });

  it('a whitespace-only PAGESPACE_TOKEN env is absent', () => {
    expect(hasExplicitCredential({}, { PAGESPACE_TOKEN: '   ' })).toBe(false);
  });

  it('a whitespace-only PAGESPACE_PROFILE env is absent', () => {
    expect(hasExplicitCredential({}, { PAGESPACE_PROFILE: '   ' })).toBe(false);
  });

  it('the legacy PAGESPACE_AUTH_TOKEN env var alone -> true — an explicit token under an old name is still explicit, not the ambient-default-profile fallback this gate exists to block', () => {
    expect(hasExplicitCredential({}, { PAGESPACE_AUTH_TOKEN: 'legacy_value' })).toBe(true);
  });

  it('PAGESPACE_TOKEN still wins over a simultaneously-set legacy PAGESPACE_AUTH_TOKEN, matching resolveEnvToken precedence', () => {
    expect(hasExplicitCredential({}, { PAGESPACE_TOKEN: 'current', PAGESPACE_AUTH_TOKEN: 'legacy' })).toBe(true);
  });
});

describe('noExplicitCredentialMessage', () => {
  it('points at tokens create, --save-as-profile, and how to pass the result, with no secret material', () => {
    const message = noExplicitCredentialMessage();
    expect(message).toContain('pagespace mcp');
    expect(message).toContain('tokens create');
    expect(message).toContain('--save-as-profile');
    expect(message).toContain('PAGESPACE_TOKEN');
    expect(message).toContain('--profile');
  });
});
