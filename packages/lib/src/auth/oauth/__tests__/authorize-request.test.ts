/**
 * Pure validation for GET /api/oauth/authorize (ADR 0002 Decisions 1-3, task
 * page hn80whvl8p00jdhv3gt8nlr6). Fail-closed: an unknown client or
 * unregistered redirect_uri must NEVER produce a redirect (open-redirect
 * guard); every other rejection redirects to the (now-validated) redirect_uri
 * with `error=` per RFC 6749 §4.1.2.1.
 */
import { describe, it, expect } from 'vitest';
import { validateAuthorizeRequest, type AuthorizeRequestParams } from '../authorize-request';
import { getRegisteredClient, PAGESPACE_CLI_CLIENT_ID, type RegisteredClient } from '../clients';
import { scopeSetFitsCap } from '../client-registration';
import { parseScopeList } from '../scopes';

const client = getRegisteredClient(PAGESPACE_CLI_CLIENT_ID)!;
const REDIRECT_URI = 'http://127.0.0.1:51234/callback';

function baseParams(overrides: Partial<AuthorizeRequestParams> = {}): AuthorizeRequestParams {
  return {
    clientId: 'pagespace-cli',
    redirectUri: REDIRECT_URI,
    responseType: 'code',
    codeChallenge: 'a'.repeat(43),
    codeChallengeMethod: 'S256',
    scope: 'account',
    state: 'xyz123',
    ...overrides,
  };
}

describe('validateAuthorizeRequest', () => {
  it('accepts a fully valid request', () => {
    const result = validateAuthorizeRequest(baseParams(), client);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.redirectUri).toBe(REDIRECT_URI);
      expect(result.client.clientId).toBe('pagespace-cli');
      expect(result.codeChallenge).toBe('a'.repeat(43));
      expect(result.state).toBe('xyz123');
      expect(result.scopes.account).toBe(true);
    }
  });

  it('accepts a request with no state (state is optional)', () => {
    const result = validateAuthorizeRequest(baseParams({ state: undefined }), client);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.state).toBeUndefined();
  });

  describe('no-redirect failures (open-redirect guard)', () => {
    it('rejects an unknown client_id without redirecting', () => {
      const result = validateAuthorizeRequest(baseParams(), null);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe('no_redirect');
        expect(result.error).toBe('invalid_client');
      }
    });

    it('rejects a missing redirect_uri without redirecting', () => {
      const result = validateAuthorizeRequest(baseParams({ redirectUri: undefined }), client);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.kind).toBe('no_redirect');
    });

    it('rejects an unregistered redirect_uri without redirecting', () => {
      const result = validateAuthorizeRequest(baseParams({ redirectUri: 'http://evil.example.com/callback' }), client);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe('no_redirect');
        expect(result.error).toBe('invalid_redirect_uri');
      }
    });

    it('rejects a substring/prefix-attack redirect_uri without redirecting', () => {
      const result = validateAuthorizeRequest(
        baseParams({ redirectUri: 'http://127.0.0.1:51234/callback.evil.com' }),
        client,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.kind).toBe('no_redirect');
    });

    it('rejects a wrong-path loopback redirect_uri without redirecting', () => {
      const result = validateAuthorizeRequest(
        baseParams({ redirectUri: 'http://127.0.0.1:51234/other-path' }),
        client,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.kind).toBe('no_redirect');
    });

    it('rejects `localhost` (numeric loopback literal required, RFC 8252 §8.3)', () => {
      const result = validateAuthorizeRequest(
        baseParams({ redirectUri: 'http://localhost:51234/callback' }),
        client,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.kind).toBe('no_redirect');
    });
  });

  describe('redirect failures (redirect_uri already validated)', () => {
    it('rejects an unsupported response_type by redirecting with error=', () => {
      const result = validateAuthorizeRequest(baseParams({ responseType: 'token' }), client);
      expect(result.ok).toBe(false);
      if (!result.ok && result.kind === 'redirect') {
        expect(result.error).toBe('unsupported_response_type');
        expect(result.redirectUri).toBe(REDIRECT_URI);
        expect(result.state).toBe('xyz123');
      } else {
        throw new Error('expected a redirect-kind failure');
      }
    });

    it('rejects `plain` code_challenge_method by redirecting with error=', () => {
      const result = validateAuthorizeRequest(baseParams({ codeChallengeMethod: 'plain' }), client);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe('redirect');
        expect(result.error).toBe('invalid_request');
      }
    });

    it('rejects a missing code_challenge by redirecting with error=', () => {
      const result = validateAuthorizeRequest(baseParams({ codeChallenge: undefined }), client);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe('redirect');
        expect(result.error).toBe('invalid_request');
      }
    });

    it('rejects a missing scope by redirecting with error=invalid_scope', () => {
      const result = validateAuthorizeRequest(baseParams({ scope: undefined }), client);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe('redirect');
        expect(result.error).toBe('invalid_scope');
      }
    });

    it('rejects an unknown scope token by redirecting with error=invalid_scope', () => {
      const result = validateAuthorizeRequest(baseParams({ scope: 'account nonsense_scope' }), client);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('invalid_scope');
    });

    it('rejects account mixed with a drive scope by redirecting with error=invalid_scope', () => {
      const result = validateAuthorizeRequest(baseParams({ scope: 'account drive:abc123' }), client);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('invalid_scope');
    });

    it('rejects offline_access requested alone by redirecting with error=invalid_scope', () => {
      const result = validateAuthorizeRequest(baseParams({ scope: 'offline_access' }), client);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('invalid_scope');
    });

    it('echoes state verbatim on a redirect-kind failure, and omits it when absent', () => {
      const withState = validateAuthorizeRequest(baseParams({ scope: undefined, state: 'preserve-me' }), client);
      if (!withState.ok && withState.kind === 'redirect') expect(withState.state).toBe('preserve-me');

      const withoutState = validateAuthorizeRequest(baseParams({ scope: undefined, state: undefined }), client);
      if (!withoutState.ok && withoutState.kind === 'redirect') expect(withoutState.state).toBeUndefined();
    });

    describe('name required for a mint-shaped grant (the fix for the "pagespace CLI" name-loss bug)', () => {
      it('rejects a pure drive:* grant with no name: token by redirecting with error=invalid_scope', () => {
        const result = validateAuthorizeRequest(baseParams({ scope: 'drive:drv123:member offline_access' }), client);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.kind).toBe('redirect');
          expect(result.error).toBe('invalid_scope');
        }
      });

      it('rejects an all_drives grant with no name: token by redirecting with error=invalid_scope', () => {
        const result = validateAuthorizeRequest(baseParams({ scope: 'all_drives offline_access' }), client);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.kind).toBe('redirect');
          expect(result.error).toBe('invalid_scope');
        }
      });

      it('accepts a pure drive:* grant that carries a name: token', () => {
        const result = validateAuthorizeRequest(baseParams({ scope: 'drive:drv123:member name:My%20Laptop offline_access' }), client);
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.scopes.newKeyName).toBe('My Laptop');
      });

      it('accepts an all_drives grant that carries a name: token', () => {
        const result = validateAuthorizeRequest(baseParams({ scope: 'all_drives name:God%20Key offline_access' }), client);
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.scopes.newKeyName).toBe('God Key');
      });

      it('does not require a name for an update_key grant (re-scoping an existing key mints nothing)', () => {
        const result = validateAuthorizeRequest(baseParams({ scope: 'update_key:tok123 drive:drv123:member' }), client);
        expect(result.ok).toBe(true);
      });

      it('does not require a name for an activate_key grant (approves nothing minted)', () => {
        const result = validateAuthorizeRequest(baseParams({ scope: 'activate_key:tok123' }), client);
        expect(result.ok).toBe(true);
      });

      it('does not require a name for account/manage_keys grants (no mcp_tokens row minted)', () => {
        expect(validateAuthorizeRequest(baseParams({ scope: 'account offline_access' }), client).ok).toBe(true);
        expect(validateAuthorizeRequest(baseParams({ scope: 'manage_keys offline_access' }), client).ok).toBe(true);
      });

      it('rejects a name: token attached to a non-mint grant (name_without_mint_grant surfaces as invalid_scope here too)', () => {
        const result = validateAuthorizeRequest(baseParams({ scope: 'account name:Foo' }), client);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.kind).toBe('redirect');
          expect(result.error).toBe('invalid_scope');
        }
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Per-client scope caps (ADR 0004 Decision 7, Phase 1a leaf 3): a client may
// not even ASK beyond the scope shapes it declared. Rejected as invalid_scope
// on the redirect branch — after redirect_uri is trusted, before any consent
// screen could render.
// ---------------------------------------------------------------------------

describe('validateAuthorizeRequest — per-client allowedScopes cap', () => {
  const HTTPS_REDIRECT = 'https://swipesend.app/auth/pagespace/callback';
  function thirdParty(allowedScopes: string[]): RegisteredClient {
    return {
      clientId: 'app_swipesend',
      name: 'SwipeSend',
      type: 'public',
      redirectUris: [HTTPS_REDIRECT],
      allowedGrantTypes: ['authorization_code', 'refresh_token'],
      allowedScopes,
      firstParty: false,
      verified: false,
    };
  }
  const params = (scope: string) => baseParams({ clientId: 'app_swipesend', redirectUri: HTTPS_REDIRECT, scope });

  const expectInvalidScope = (result: ReturnType<typeof validateAuthorizeRequest>) => {
    expect(result).toEqual({ ok: false, kind: 'redirect', error: 'invalid_scope', redirectUri: HTTPS_REDIRECT, state: 'xyz123' });
  };

  it('accepts a request inside the cap', () => {
    expect(validateAuthorizeRequest(params('profile'), thirdParty(['profile'])).ok).toBe(true);
    expect(
      validateAuthorizeRequest(params('profile offline_access'), thirdParty(['profile', 'offline_access'])).ok,
    ).toBe(true);
  });

  it('rejects a scope the client never declared, even an identity-only one', () => {
    expectInvalidScope(validateAuthorizeRequest(params('profile offline_access'), thirdParty(['profile'])));
    expectInvalidScope(validateAuthorizeRequest(params('profile'), thirdParty(['offline_access'])));
  });

  it('matches drive scopes by SHAPE — the role must be one the cap names', () => {
    const cap = thirdParty(['profile', 'drive:member', 'offline_access']);
    expect(validateAuthorizeRequest(params('profile drive:abc123:member offline_access'), cap).ok).toBe(true);
    expectInvalidScope(validateAuthorizeRequest(params('profile drive:abc123:admin'), cap));
    expectInvalidScope(validateAuthorizeRequest(params('profile drive:abc123'), cap));
    expectInvalidScope(validateAuthorizeRequest(params('profile drive:abc123:role:rol456'), cap));
  });

  it('maps each drive role to its own shape', () => {
    expect(validateAuthorizeRequest(params('profile drive:abc123'), thirdParty(['profile', 'drive'])).ok).toBe(true);
    expect(validateAuthorizeRequest(params('profile drive:abc123:admin'), thirdParty(['profile', 'drive:admin'])).ok).toBe(true);
    expect(
      validateAuthorizeRequest(params('profile drive:abc123:role:rol456'), thirdParty(['profile', 'drive:role'])).ok,
    ).toBe(true);
  });

  it('never lets a cap reach a scope that has no shape — account, manage_keys, all_drives, key ops', () => {
    const everything = thirdParty(['profile', 'offline_access', 'drive', 'drive:admin', 'drive:member', 'drive:role', 'account', 'manage_keys', 'all_drives']);
    for (const scope of ['account', 'manage_keys offline_access', 'all_drives name:k', 'activate_key:tok1', 'update_key:tok1 drive:abc123']) {
      expectInvalidScope(validateAuthorizeRequest(params(scope), everything));
    }
  });

  it('reads an empty cap as "may ask for nothing", never as "no cap"', () => {
    expectInvalidScope(validateAuthorizeRequest(params('profile'), thirdParty([])));
  });

  it('leaves a client with no declared cap (first-party only) unchanged', () => {
    expect(validateAuthorizeRequest(baseParams({ scope: 'account' }), client).ok).toBe(true);
    expect(validateAuthorizeRequest(baseParams({ scope: 'manage_keys offline_access' }), client).ok).toBe(true);
  });
});

describe('scopeSetFitsCap', () => {
  const parse = (raw: string) => {
    const parsed = parseScopeList(raw);
    if (!parsed.ok) throw new Error(`fixture did not parse: ${raw}`);
    return parsed.scopes;
  };

  it('is true for any scope set when no cap is declared', () => {
    expect(scopeSetFitsCap(parse('account'), undefined)).toBe(true);
  });

  it('is true only when every requested shape is declared', () => {
    expect(scopeSetFitsCap(parse('profile drive:abc123:member'), ['profile', 'drive:member'])).toBe(true);
    expect(scopeSetFitsCap(parse('profile drive:abc123:member'), ['profile'])).toBe(false);
  });

  it('is false for a shapeless scope whatever the cap holds', () => {
    expect(scopeSetFitsCap(parse('account'), ['account'])).toBe(false);
  });
});

// ADR 0004 Decision 5: the `name:` requirement exists because a minted key
// needs a name. Only a first-party client mints, so only a first-party client
// is held to it.
describe('validateAuthorizeRequest — the name: rule is first-party only', () => {
  const HTTPS_REDIRECT = 'https://swipesend.app/auth/pagespace/callback';
  const uncappedThirdParty: RegisteredClient = {
    clientId: 'app_swipesend',
    name: 'SwipeSend',
    type: 'public',
    redirectUris: [HTTPS_REDIRECT],
    allowedGrantTypes: ['authorization_code'],
    firstParty: false,
    verified: false,
  };
  const params = (scope: string) => baseParams({ clientId: 'app_swipesend', redirectUri: HTTPS_REDIRECT, scope });

  it('accepts a pure drive grant with no name: from a third-party client — nothing will be minted', () => {
    expect(validateAuthorizeRequest(params('drive:abc123:member'), uncappedThirdParty).ok).toBe(true);
    expect(validateAuthorizeRequest(params('drive:abc123:member offline_access'), { ...uncappedThirdParty, allowedScopes: ['drive:member', 'offline_access'] }).ok).toBe(true);
  });

  it('still requires name: for the first-party CLI', () => {
    const result = validateAuthorizeRequest(baseParams({ scope: 'drive:abc123:member' }), client);
    expect(result).toMatchObject({ ok: false, kind: 'redirect', error: 'invalid_scope' });
  });

  it('rejects a name: from a capped third-party client — there is no key for it to name', () => {
    const result = validateAuthorizeRequest(
      params('drive:abc123:member name:k'),
      { ...uncappedThirdParty, allowedScopes: ['drive:member'] },
    );
    expect(result).toMatchObject({ ok: false, kind: 'redirect', error: 'invalid_scope' });
  });
});
