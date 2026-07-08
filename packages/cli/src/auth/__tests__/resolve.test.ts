import { describe, expect, it } from 'vitest';
import { hasExplicitCredential, mcpNoExplicitCredentialMessage, missingCredentialsMessage, noExplicitCredentialMessage, resolveAuth, resolveKeyName } from '../resolve.js';
import type { OAuthHostCredential } from '../../credentials/serialize.js';

const HOST = 'https://pagespace.ai';
const OTHER_HOST = 'https://self-hosted.example';

const CREDENTIAL: OAuthHostCredential = {
  kind: 'oauth',
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
      kind: 'stored',
      host: HOST,
      keyName: 'default',
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
    const other: OAuthHostCredential = { ...CREDENTIAL, refreshToken: 'ps_rt_other_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' };
    const profiles = { [HOST]: { default: CREDENTIAL }, [OTHER_HOST]: { default: other } };
    expect(resolveAuth({}, {}, profiles, HOST)).toEqual({
      kind: 'stored',
      host: HOST,
      keyName: 'default',
      credential: CREDENTIAL,
    });
    expect(resolveAuth({}, {}, profiles, OTHER_HOST)).toEqual({
      kind: 'stored',
      host: OTHER_HOST,
      keyName: 'default',
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
      kind: 'stored',
      host: HOST,
      keyName: 'default',
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

describe('resolveAuth — named keys (Phase 8 task 3)', () => {
  const WORK_CREDENTIAL: OAuthHostCredential = { ...CREDENTIAL, refreshToken: 'ps_rt_work_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' };

  it('resolves the credential stored under the given key name, keyed one level deeper than host', () => {
    const profiles = { [HOST]: { default: CREDENTIAL, work: WORK_CREDENTIAL } };
    expect(resolveAuth({}, {}, profiles, HOST, 'work')).toEqual({
      kind: 'stored',
      host: HOST,
      keyName: 'work',
      credential: WORK_CREDENTIAL,
    });
  });

  it('defaults to the "default" key name when none is given', () => {
    const profiles = { [HOST]: { default: CREDENTIAL, work: WORK_CREDENTIAL } };
    expect(resolveAuth({}, {}, profiles, HOST)).toEqual({
      kind: 'stored',
      host: HOST,
      keyName: 'default',
      credential: CREDENTIAL,
    });
  });

  it('a host with only a non-default key never leaks in under a different key name -> none', () => {
    const profiles = { [HOST]: { work: WORK_CREDENTIAL } };
    expect(resolveAuth({}, {}, profiles, HOST, 'default')).toEqual({ kind: 'none', host: HOST });
  });

  it('an unknown key name on a host with other keys stored -> none', () => {
    const profiles = { [HOST]: { default: CREDENTIAL } };
    expect(resolveAuth({}, {}, profiles, HOST, 'nonexistent')).toEqual({ kind: 'none', host: HOST });
  });
});

describe('resolveAuth — prototype-named keys are ordinary data, never Object.prototype lookups', () => {
  const PROTOTYPE_NAMES = ['__proto__', 'constructor', 'toString'] as const;

  it('a prototype-named key that was never stored resolves to none, not a bogus Object.prototype credential', () => {
    const profiles = { [HOST]: { default: CREDENTIAL } };
    for (const name of PROTOTYPE_NAMES) {
      expect(resolveAuth({}, {}, profiles, HOST, name)).toEqual({ kind: 'none', host: HOST });
    }
  });

  it('a prototype-named key that was never stored resolves to none even with no keys for the host at all', () => {
    for (const name of PROTOTYPE_NAMES) {
      expect(resolveAuth({}, {}, {}, HOST, name)).toEqual({ kind: 'none', host: HOST });
    }
  });

  it('stores and resolves a genuinely prototype-named key like any other name', () => {
    for (const name of PROTOTYPE_NAMES) {
      const profiles = { [HOST]: { [name]: CREDENTIAL } };
      expect(resolveAuth({}, {}, profiles, HOST, name)).toEqual({
        kind: 'stored',
        host: HOST,
        keyName: name,
        credential: CREDENTIAL,
      });
    }
  });
});

describe('resolveAuth — prototype-named hosts are ordinary data, never Object.prototype lookups', () => {
  const PROTOTYPE_NAMES = ['__proto__', 'constructor', 'toString'] as const;

  it('a prototype-named host that was never stored resolves to none, not a bogus Object.prototype credential', () => {
    for (const name of PROTOTYPE_NAMES) {
      expect(resolveAuth({}, {}, {}, name)).toEqual({ kind: 'none', host: name });
    }
  });

  it('a prototype-named host that was never stored resolves to none even with a genuinely stored host present', () => {
    const profiles = { [HOST]: { default: CREDENTIAL } };
    for (const name of PROTOTYPE_NAMES) {
      expect(resolveAuth({}, {}, profiles, name)).toEqual({ kind: 'none', host: name });
    }
  });

  it('a bracket read of a never-stored prototype-named host must not surface an own property of the prototype chain as a bogus credential', () => {
    // `profiles['__proto__']` bracket-reads to `Object.prototype` itself (not
    // undefined), `profiles['constructor']` to the `Object` function, and
    // `profiles['toString']` to `Function.prototype.toString` — each of
    // which owns real properties (`toString`, `name`) that a bare
    // `Object.hasOwn(hostProfiles, profileName)` check would happily find,
    // returning that unrelated prototype member as `credential`.
    expect(resolveAuth({}, {}, {}, '__proto__', 'toString')).toEqual({ kind: 'none', host: '__proto__' });
    expect(resolveAuth({}, {}, {}, 'constructor', 'name')).toEqual({ kind: 'none', host: 'constructor' });
    expect(resolveAuth({}, {}, {}, 'toString', 'name')).toEqual({ kind: 'none', host: 'toString' });
  });

  it('stores and resolves a genuinely prototype-named host like any other host', () => {
    for (const name of PROTOTYPE_NAMES) {
      const profiles = { [name]: { default: CREDENTIAL } };
      expect(resolveAuth({}, {}, profiles, name)).toEqual({
        kind: 'stored',
        host: name,
        keyName: 'default',
        credential: CREDENTIAL,
      });
    }
  });
});

describe('resolveKeyName — precedence table', () => {
  it('flag alone -> flag value', () => {
    expect(resolveKeyName({ key: 'work' }, {})).toBe('work');
  });

  it('flag beats env', () => {
    expect(resolveKeyName({ key: 'work' }, { PAGESPACE_KEY: 'personal' })).toBe('work');
  });

  it('env alone -> env value', () => {
    expect(resolveKeyName({}, { PAGESPACE_KEY: 'personal' })).toBe('personal');
  });

  it('nothing present -> "default"', () => {
    expect(resolveKeyName({}, {})).toBe('default');
  });

  it('an empty-string flag is absent, falls through to env', () => {
    expect(resolveKeyName({ key: '' }, { PAGESPACE_KEY: 'personal' })).toBe('personal');
  });

  it('a whitespace-only env value is absent, falls through to "default"', () => {
    expect(resolveKeyName({}, { PAGESPACE_KEY: '   ' })).toBe('default');
  });

  it('trims surrounding whitespace from a winning flag value', () => {
    expect(resolveKeyName({ key: '  work  \n' }, {})).toBe('work');
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

  it('--key flag alone -> true, even with no matching stored credential', () => {
    expect(hasExplicitCredential({ key: 'agent' }, {})).toBe(true);
  });

  it('PAGESPACE_KEY env alone -> true', () => {
    expect(hasExplicitCredential({}, { PAGESPACE_KEY: 'agent' })).toBe(true);
  });

  it('the legacy PAGESPACE_PROFILE env alone -> true — an explicit key name under the old var name is still explicit', () => {
    expect(hasExplicitCredential({}, { PAGESPACE_PROFILE: 'agent' })).toBe(true);
  });

  it('an explicit --key "default" still counts as explicit — the user named it, not the resolver', () => {
    expect(hasExplicitCredential({ key: 'default' }, {})).toBe(true);
  });

  it('a whitespace-only --token flag is absent, same as resolveAuth', () => {
    expect(hasExplicitCredential({ token: '   ' }, {})).toBe(false);
  });

  it('a whitespace-only --key flag is absent, same as resolveKeyName', () => {
    expect(hasExplicitCredential({ key: '\n\t' }, {})).toBe(false);
  });

  it('a whitespace-only PAGESPACE_TOKEN env is absent', () => {
    expect(hasExplicitCredential({}, { PAGESPACE_TOKEN: '   ' })).toBe(false);
  });

  it('a whitespace-only PAGESPACE_KEY env is absent', () => {
    expect(hasExplicitCredential({}, { PAGESPACE_KEY: '   ' })).toBe(false);
  });

  it('a whitespace-only legacy PAGESPACE_PROFILE env is absent', () => {
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
  it('points at keys create --name and every way to pass a credential — --key, PAGESPACE_KEY, --token, keys use — with no secret material', () => {
    const message = noExplicitCredentialMessage();
    expect(message).toMatch(/never falls back to your personal login/i);
    expect(message).toContain('keys create');
    expect(message).toContain('--name');
    expect(message).toContain(
      'Pass --key <name> (or set PAGESPACE_KEY), pass --token, or activate a key for this machine with "pagespace keys use <name>".',
    );
  });
});

describe('mcpNoExplicitCredentialMessage', () => {
  it('never suggests the active key as a fix — it says outright that keys use does not apply to pagespace mcp', () => {
    const message = mcpNoExplicitCredentialMessage();
    expect(message).toMatch(/never falls back to your personal login/i);
    expect(message).toContain('--key <name>');
    expect(message).toContain('PAGESPACE_KEY');
    expect(message).toContain('deliberately does not apply to "pagespace mcp"');
    expect(message).not.toMatch(/activate a key for this machine/i);
  });
});
