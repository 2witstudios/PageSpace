/**
 * Pure validation for GET /api/oauth/authorize (ADR 0002 Decisions 1-3, task
 * page hn80whvl8p00jdhv3gt8nlr6). Fail-closed: an unknown client or
 * unregistered redirect_uri must NEVER produce a redirect (open-redirect
 * guard); every other rejection redirects to the (now-validated) redirect_uri
 * with `error=` per RFC 6749 §4.1.2.1.
 */
import { describe, it, expect } from 'vitest';
import { validateAuthorizeRequest, type AuthorizeRequestParams } from '../authorize-request';
import { getRegisteredClient, PAGESPACE_CLI_CLIENT_ID } from '../clients';

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
