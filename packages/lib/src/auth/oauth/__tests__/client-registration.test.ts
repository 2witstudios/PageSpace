/**
 * Client registration metadata validation (ADR 0004 Decisions 3 and 7).
 *
 * The input is whatever a developer console POST body contained — untrusted
 * by construction. The validator takes `unknown`, never throws, and returns a
 * typed error list; every rejection is a rule from the ADR, and the redirect
 * rules are the SAME function authorize uses, applied with `firstParty:
 * false` so nothing registrable through this door can ever claim the loopback
 * port wildcard.
 */
import { describe, it, expect } from 'vitest';
import { validateClientRegistration, type ClientRegistrationError } from '../client-registration';
import { validateRedirectUri } from '../clients';

const valid = {
  name: 'SwipeSend',
  redirectUris: ['https://swipesend.example.com/auth/pagespace/callback'],
};

function codes(input: unknown): string[] {
  const result = validateClientRegistration(input);
  return result.ok ? [] : result.errors.map((error: ClientRegistrationError) => error.code);
}

function fieldsFor(input: unknown, code: string): Array<string | undefined> {
  const result = validateClientRegistration(input);
  if (result.ok) return [];
  return result.errors.filter((error) => error.code === code).map((error) => error.field);
}

describe('validateClientRegistration — the happy path', () => {
  it('accepts the minimum: a name and one https redirect', () => {
    const result = validateClientRegistration(valid);
    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toEqual({
      name: 'SwipeSend',
      redirectUris: ['https://swipesend.example.com/auth/pagespace/callback'],
    });
  });

  it('accepts the full metadata set a consent screen renders', () => {
    const result = validateClientRegistration({
      name: 'SwipeSend',
      description: 'Send things by swiping',
      logoUrl: 'https://cdn.example.com/logo.png',
      homepageUrl: 'https://swipesend.example.com',
      redirectUris: ['https://swipesend.example.com/auth/pagespace/callback', 'swipesend://callback'],
      allowedScopes: ['profile', 'offline_access', 'drive', 'drive:admin', 'drive:member', 'drive:role'],
    });
    expect(result.ok).toBe(true);
  });

  it('drops unknown properties rather than carrying them through', () => {
    const result = validateClientRegistration({ ...valid, isAdmin: true, firstParty: true, verified: true });
    expect(result.ok).toBe(true);
    expect(result.ok && Object.keys(result.value).sort()).toEqual(['name', 'redirectUris']);
  });
});

describe('validateClientRegistration — never throws on untrusted input', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'SwipeSend'],
    ['a number', 42],
    ['an array', []],
    ['an empty object', {}],
    ['a nested junk object', { name: { toString: 'no' }, redirectUris: { length: 1 } }],
    // A plain JSON body can shadow `toString` with a non-callable, which makes
    // `String(value)` throw `TypeError: Cannot convert object to primitive
    // value`. Reported by Codex on PR #2612: the validator must never coerce a
    // caller-controlled value, or an untrusted registration body becomes a 500.
    ['a scope entry with a poisoned toString', JSON.parse('{"name":"x","redirectUris":["https://a.example.com/cb"],"allowedScopes":[{"toString":"no"}]}')],
    ['a scope entry with a poisoned valueOf', JSON.parse('{"name":"x","redirectUris":["https://a.example.com/cb"],"allowedScopes":[{"valueOf":"no","toString":"no"}]}')],
    ['a redirect entry with a poisoned toString', JSON.parse('{"name":"x","redirectUris":[{"toString":"no"}]}')],
  ])('returns errors for %s instead of throwing', (_label, input) => {
    let result: ReturnType<typeof validateClientRegistration> | undefined;
    expect(() => {
      result = validateClientRegistration(input);
    }).not.toThrow();
    expect(result?.ok).toBe(false);
    expect(result?.ok === false && result.errors.length).toBeGreaterThan(0);
  });
});

describe('validateClientRegistration — non-string entries report a constant shape', () => {
  it('never invokes caller-controlled coercion on a non-string scope entry', () => {
    const poisoned = JSON.parse('{"name":"x","redirectUris":["https://a.example.com/cb"],"allowedScopes":[{"toString":"no"}]}');
    const result = validateClientRegistration(poisoned);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors).toEqual([
      { code: 'unknown_scope', field: 'allowedScopes[0]', scope: '[non-string]' },
    ]);
  });

  it('uses the same fixed placeholder for every non-string scope entry, so the error leaks nothing about the input', () => {
    for (const entry of [7, null, true, [], {}] as unknown[]) {
      const result = validateClientRegistration({ ...valid, allowedScopes: [entry] });
      expect(result.ok === false && result.errors[0]).toEqual({
        code: 'unknown_scope',
        field: 'allowedScopes[0]',
        scope: '[non-string]',
      });
    }
  });
});

describe('validateClientRegistration — a registration body cannot reach anything but its own fields', () => {
  it('drops an own `__proto__` property and pollutes nothing', () => {
    // `JSON.parse` creates `__proto__` as an OWN property rather than setting
    // the prototype, so it survives into the object a route would hand us.
    // Nothing here copies caller keys into a fresh object, which is what makes
    // this safe — asserted rather than assumed, because the safety comes from
    // the rebuild-field-by-field shape and a future refactor to a spread would
    // silently lose it.
    const input = JSON.parse('{"__proto__":{"polluted":"yes"},"name":"x","redirectUris":["https://a.example.com/cb"]}');
    const result = validateClientRegistration(input);
    expect(result.ok).toBe(true);
    expect(result.ok && Object.keys(result.value).sort()).toEqual(['name', 'redirectUris']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object.prototype as unknown as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('does not let a `constructor` or `prototype` key through either', () => {
    const input = JSON.parse('{"constructor":{"x":1},"prototype":{"y":2},"name":"x","redirectUris":["https://a.example.com/cb"]}');
    const result = validateClientRegistration(input);
    expect(result.ok && Object.keys(result.value).sort()).toEqual(['name', 'redirectUris']);
  });
});

describe('validateClientRegistration — name', () => {
  it('rejects an empty name', () => {
    expect(codes({ ...valid, name: '' })).toContain('invalid_name');
  });

  it('rejects a name over 100 characters', () => {
    expect(codes({ ...valid, name: 'a'.repeat(101) })).toContain('invalid_name');
    expect(validateClientRegistration({ ...valid, name: 'a'.repeat(100) }).ok).toBe(true);
  });

  it('rejects a whitespace-only name — it renders as blank next to the "Unverified app" badge', () => {
    for (const name of ['   ', '\t', '\n', ' \u00a0 ']) {
      expect(codes({ ...valid, name })).toContain('invalid_name');
    }
  });

  it('rejects leading or trailing whitespace rather than trimming it, so what is stored is what renders', () => {
    for (const name of ['  SwipeSend', 'SwipeSend  ', '\tSwipeSend', 'SwipeSend\n']) {
      expect(codes({ ...valid, name })).toContain('invalid_name');
    }
    expect(validateClientRegistration({ ...valid, name: 'Swipe Send' }).ok).toBe(true);
  });

  it('rejects control characters and bidi/zero-width overrides in a name (parity with mcp key names, scopes.ts NAME_CONTROL_CHAR_RE)', () => {
    // The consent screen renders this string beside the trust badge, which is
    // exactly where a spoofed name pays off: an RTL override can visually
    // reorder the text around the badge it is meant to undercut.
    for (const name of ['ev\u0000il', 'ev\u001bil', 'ev\u007fil', 'ev\u202eil', 'ev\u200bil', 'ev\ufeffil', 'ev\u061cil', 'ev\u2066il']) {
      expect(codes({ ...valid, name })).toContain('invalid_name');
    }
  });

  it('still accepts ordinary non-ASCII names — this is a control-character rule, not an ASCII rule', () => {
    for (const name of ['Sw\u00efpeSend', '\u5f52\u6863', 'Caf\u00e9 App', 'App \u2014 One']) {
      expect(validateClientRegistration({ ...valid, name }).ok).toBe(true);
    }
  });

  it('rejects a missing or non-string name', () => {
    expect(codes({ redirectUris: valid.redirectUris })).toContain('invalid_name');
    expect(codes({ ...valid, name: 7 })).toContain('invalid_name');
  });
});

describe('validateClientRegistration — description', () => {
  it('accepts an absent description and one at the 500-character cap', () => {
    expect(validateClientRegistration(valid).ok).toBe(true);
    expect(validateClientRegistration({ ...valid, description: 'd'.repeat(500) }).ok).toBe(true);
  });

  it('rejects a description over 500 characters', () => {
    expect(codes({ ...valid, description: 'd'.repeat(501) })).toContain('invalid_description');
  });

  it('holds the description to the same display rule as the name — it renders on the same screen', () => {
    for (const description of ['ev\u0000il', 'ev\u202eil', 'ev\u200bil', 'ev\u061cil', 'ev\u007fil']) {
      expect(codes({ ...valid, description })).toContain('invalid_description');
    }
    expect(validateClientRegistration({ ...valid, description: 'Envía cosas — deslizando' }).ok).toBe(true);
  });
});

describe('validateClientRegistration — logo and homepage are https only', () => {
  it.each([
    ['logoUrl', 'invalid_logo_url'],
    ['homepageUrl', 'invalid_homepage_url'],
  ])('%s rejects http, private-use schemes, javascript:, and junk', (field, code) => {
    for (const value of [
      'http://example.com/logo.png',
      'swipesend://logo',
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
      '//example.com/logo.png',
      'not a url',
      '',
      12,
    ]) {
      expect(codes({ ...valid, [field]: value })).toContain(code);
    }
  });

  it.each([
    ['logoUrl', 'https://cdn.example.com/logo.png'],
    ['homepageUrl', 'https://example.com'],
  ])('%s accepts an https url', (field, value) => {
    expect(validateClientRegistration({ ...valid, [field]: value }).ok).toBe(true);
  });
});

describe('validateClientRegistration — redirect URIs', () => {
  it('requires at least one', () => {
    expect(codes({ ...valid, redirectUris: [] })).toContain('invalid_redirect_uris');
    expect(codes({ name: 'SwipeSend' })).toContain('invalid_redirect_uris');
  });

  it('caps the list at 10', () => {
    const ten = Array.from({ length: 10 }, (_unused, index) => `https://app.example.com/cb${index}`);
    expect(validateClientRegistration({ ...valid, redirectUris: ten }).ok).toBe(true);
    expect(codes({ ...valid, redirectUris: [...ten, 'https://app.example.com/cb10'] })).toContain('invalid_redirect_uris');
  });

  it('rejects a non-array or non-string entries', () => {
    expect(codes({ ...valid, redirectUris: 'https://app.example.com/cb' })).toContain('invalid_redirect_uris');
    expect(codes({ ...valid, redirectUris: [42] })).toContain('invalid_redirect_uri');
  });

  it('applies the SAME redirect rules authorize applies, as a non-first-party client', () => {
    for (const uri of [
      'http://127.0.0.1/callback',
      'http://127.0.0.1:51234/callback',
      'http://[::1]/callback',
      'http://localhost:3000/callback',
      'https://localhost/callback',
      'http://app.example.com/callback',
      'https://*.example.com/callback',
      'https://user@app.example.com/callback',
      'https://app.example.com/callback?x=1',
      'https://app.example.com/callback#x',
      'javascript://callback',
      'not a uri',
      '',
    ]) {
      expect(codes({ ...valid, redirectUris: [uri] })).toContain('invalid_redirect_uri');
    }
  });

  it('accepts https and private-use schemes', () => {
    expect(validateClientRegistration({ ...valid, redirectUris: ['https://app.example.com/auth/pagespace/callback'] }).ok).toBe(true);
    expect(validateClientRegistration({ ...valid, redirectUris: ['swipesend://callback'] }).ok).toBe(true);
    expect(validateClientRegistration({ ...valid, redirectUris: ['com.example.app://oauth/callback'] }).ok).toBe(true);
  });

  it('names the offending entry by index so the console can point at it', () => {
    expect(fieldsFor({ ...valid, redirectUris: ['https://ok.example.com/cb', 'http://127.0.0.1/cb'] }, 'invalid_redirect_uri')).toEqual([
      'redirectUris[1]',
    ]);
  });

  it('rejects duplicate redirect URIs', () => {
    expect(codes({ ...valid, redirectUris: ['https://app.example.com/cb', 'https://app.example.com/cb'] })).toContain(
      'duplicate_redirect_uri',
    );
  });

  it('invariant: every uri validateRedirectUri accepts is parseable, so registration can normalize it unguarded', () => {
    // `validateClientRegistration` calls `new URL(uri).href` without a
    // try/catch after `validateRedirectUri` returns true. That is only sound
    // while this holds, so it is asserted rather than assumed.
    for (const uri of [
      'https://app.example.com/auth/pagespace/callback',
      'https://app.example.com:8443/cb',
      'swipesend://callback',
      'com.example.app://oauth/callback',
      'https://127.0.0.1/callback',
    ]) {
      expect(validateRedirectUri({ redirectUris: [uri], firstParty: false }, uri)).toBe(true);
      expect(() => new URL(uri)).not.toThrow();
    }
  });

  it('dedupes on the NORMALIZED uri, because that is what authorize matches on', () => {
    // `validateRedirectUri` compares `candidate.href === pattern.href`, and the
    // URL parser drops the default port and lowercases the host. A raw-string
    // dedupe would store two entries the authorize endpoint treats as one.
    for (const pair of [
      ['https://app.example.com/cb', 'https://app.example.com:443/cb'],
      ['https://app.example.com/cb', 'https://APP.example.com/cb'],
      ['https://app.example.com/cb', 'HTTPS://app.example.com/cb'],
    ]) {
      expect(codes({ ...valid, redirectUris: pair })).toContain('duplicate_redirect_uri');
    }
  });
});

describe('validateClientRegistration — allowedScopes are shapes, and only three kinds', () => {
  it('accepts profile, offline_access and every drive shape token', () => {
    for (const scope of ['profile', 'offline_access', 'drive', 'drive:admin', 'drive:member', 'drive:role']) {
      expect(validateClientRegistration({ ...valid, allowedScopes: [scope] }).ok).toBe(true);
    }
  });

  it('rejects every scope a third party may not declare', () => {
    for (const scope of ['account', 'all_drives', 'manage_keys', 'update_key', 'activate_key', 'name']) {
      expect(codes({ ...valid, allowedScopes: [scope] })).toContain('forbidden_scope');
    }
  });

  it('rejects a CONCRETE scope where a shape belongs — a cap names shapes, not one drive', () => {
    for (const scope of ['drive:abc123', 'drive:abc123:member', 'drive:role:role01', 'update_key:tok123', 'activate_key:tok123', 'name:ci']) {
      const result = validateClientRegistration({ ...valid, allowedScopes: [scope] });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.errors.some((error) => error.code === 'forbidden_scope' || error.code === 'unknown_scope')).toBe(true);
    }
  });

  it('rejects an unknown scope token', () => {
    expect(codes({ ...valid, allowedScopes: ['pages:read'] })).toContain('unknown_scope');
    expect(codes({ ...valid, allowedScopes: ['PROFILE'] })).toContain('unknown_scope');
  });

  it('rejects a non-array allowedScopes and non-string entries', () => {
    expect(codes({ ...valid, allowedScopes: 'profile' })).toContain('invalid_allowed_scopes');
    expect(codes({ ...valid, allowedScopes: [7] })).toContain('unknown_scope');
  });

  it('rejects an empty allowedScopes array — declaring a cap of nothing is a mistake, not a grant of everything', () => {
    expect(codes({ ...valid, allowedScopes: [] })).toContain('invalid_allowed_scopes');
  });

  it('caps the list — there are only six legal shapes, so a longer array is a mistake or an abuse', () => {
    const twenty = Array.from({ length: 20 }, (_unused, index) => (index === 0 ? 'profile' : `bogus${index}`));
    expect(codes({ ...valid, allowedScopes: twenty })).not.toContain('invalid_allowed_scopes');
    const twentyOne = Array.from({ length: 21 }, (_unused, index) => (index === 0 ? 'profile' : `bogus${index}`));
    expect(codes({ ...valid, allowedScopes: twentyOne })).toContain('invalid_allowed_scopes');
  });

  it('rejects duplicates', () => {
    expect(codes({ ...valid, allowedScopes: ['profile', 'profile'] })).toContain('duplicate_scope');
  });

  it('names the offending scope on the error so the console can show which one', () => {
    const result = validateClientRegistration({ ...valid, allowedScopes: ['account'] });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors[0]).toEqual({ code: 'forbidden_scope', field: 'allowedScopes[0]', scope: 'account' });
  });
});

describe('validateClientRegistration — reports every problem at once', () => {
  it('collects errors across fields rather than stopping at the first', () => {
    const found = codes({ name: '', logoUrl: 'http://x.test/l.png', redirectUris: ['http://127.0.0.1/cb'], allowedScopes: ['account'] });
    expect(found).toEqual(expect.arrayContaining(['invalid_name', 'invalid_logo_url', 'invalid_redirect_uri', 'forbidden_scope']));
  });
});
