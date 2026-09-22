/**
 * L2·G2 — `decideAccountCreation`: what a human asked to store, as a verdict,
 * before anything touches the database or the credential plane.
 *
 * Requirements (task r17kt880rmgn4urtgpaicn5q):
 * - an account kind not yet implemented in this slice (anything but `api_key`)
 *   is rejected at creation with a typed reason — the kind union already holds
 *   `session` and `password` (D-20), so later gates add behaviour, not variants;
 * - a personal credential is stored only after the explicit acknowledgment;
 * - the account is pinned to canonical origins (ADR 0004 §3.2).
 * The key's placement may name `authorization` (the executor sets it), but no
 * header the transport owns or the request projection carries.
 */
import { describe, expect, it } from 'vitest';
import type { AccountKind } from '@pagespace/db/schema/agent-accounts';
import { decideAccountCreation } from '../decide-account-creation';

const base = {
  kind: 'api_key' as AccountKind,
  name: '  Weather API  ',
  allowedOrigins: ['https://api.weather.example'],
  ownership: 'dedicated' as const,
  acknowledged: false,
  placement: { in: 'header' as const, name: 'Authorization' },
};

describe('decideAccountCreation', () => {
  it('given a dedicated api_key account, should produce a draft with canonical origins, a trimmed name and the recorded acknowledgment', () => {
    const actual = decideAccountCreation(base);
    const expected = {
      ok: true,
      draft: {
        kind: 'api_key',
        name: 'Weather API',
        allowedOrigins: ['https://api.weather.example:443'],
        acknowledgment: 'dedicated_agent_account',
        placement: { in: 'header', name: 'authorization' },
      },
    };
    expect(actual).toEqual(expected);
  });

  it('given any kind but api_key, should refuse kind_not_supported before anything else', () => {
    const kinds: readonly AccountKind[] = ['bearer', 'oauth2', 'session', 'password'];
    const actual = kinds.map((kind) => decideAccountCreation({ ...base, kind, allowedOrigins: [] }));
    const expected = kinds.map(() => ({ ok: false, reason: 'kind_not_supported' }));
    expect(actual).toEqual(expected);
  });

  it('given a personal login without the acknowledgment, should refuse; with it, should record personal_login_acknowledged', () => {
    const actual = [
      decideAccountCreation({ ...base, ownership: 'personal', acknowledged: false }),
      decideAccountCreation({ ...base, ownership: 'personal', acknowledged: true }),
    ].map((verdict) => (verdict.ok ? verdict.draft.acknowledgment : verdict.reason));
    const expected = ['acknowledgment_required', 'personal_login_acknowledged'];
    expect(actual).toEqual(expected);
  });

  it('given duplicate spellings of one origin in any order, should pin each canonical origin once, sorted', () => {
    const verdict = decideAccountCreation({ ...base, allowedOrigins: ['https://b.example', 'https://A.example:443', 'https://b.example/'] });
    const actual = verdict.ok ? verdict.draft.allowedOrigins : verdict;
    const expected = ['https://a.example:443', 'https://b.example:443'];
    expect(actual).toEqual(expected);
  });

  it('given no origin, or one that breaks the origin rule, should refuse and name which one and why', () => {
    const actual = [decideAccountCreation({ ...base, allowedOrigins: [] }), decideAccountCreation({ ...base, allowedOrigins: ['https://ok.example', 'http://plain.example'] })];
    const expected = [
      { ok: false, reason: 'origins_empty' },
      { ok: false, reason: 'origin_invalid', index: 1, rule: 'scheme_not_https' },
    ];
    expect(actual).toEqual(expected);
  });

  it('given an empty or over-long name, should refuse name_invalid', () => {
    const actual = [decideAccountCreation({ ...base, name: '   ' }), decideAccountCreation({ ...base, name: 'x'.repeat(101) })];
    const expected = [
      { ok: false, reason: 'name_invalid' },
      { ok: false, reason: 'name_invalid' },
    ];
    expect(actual).toEqual(expected);
  });

  it('given a placement header the transport or the request projection owns, or a malformed name, should refuse placement_invalid', () => {
    const names = ['Cookie', 'Host', 'Proxy-Authorization', 'X-Forwarded-For', 'Content-Length', 'Content-Type', 'Accept', 'Transfer-Encoding', 'Connection', 'Upgrade', 'bad name', ''];
    const actual = names.map((name) => decideAccountCreation({ ...base, placement: { in: 'header', name } }));
    const expected = names.map(() => ({ ok: false, reason: 'placement_invalid' }));
    expect(actual).toEqual(expected);
  });

  it('given a custom header or a query parameter placement, should accept it lowercased for headers and verbatim for query', () => {
    const actual = [
      decideAccountCreation({ ...base, placement: { in: 'header', name: 'X-Api-Key' } }),
      decideAccountCreation({ ...base, placement: { in: 'query', name: 'api_key' } }),
      decideAccountCreation({ ...base, placement: { in: 'query', name: 'a&b=c' } }),
    ].map((verdict) => (verdict.ok ? verdict.draft.placement : verdict.reason));
    const expected = [{ in: 'header', name: 'x-api-key' }, { in: 'query', name: 'api_key' }, 'placement_invalid'];
    expect(actual).toEqual(expected);
  });
});
