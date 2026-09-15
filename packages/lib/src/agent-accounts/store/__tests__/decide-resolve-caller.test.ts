/**
 * ADR 0005 §4.2, §8 F1/F2/F2a, §10.3 — RED at G1b-store before
 * `decide-resolve-caller.ts` existed.
 */
import { describe, it, expect } from 'vitest';
import { decideResolveCaller } from '../decide-resolve-caller';

describe('decideResolveCaller', () => {
  it('given kind password and channel http-executor, should return kind_not_resolvable', () => {
    const actual = decideResolveCaller({ aud: 'http-executor', kind: 'password' });
    expect(actual).toEqual({ ok: false, reason: 'kind_not_resolvable' });
  });

  it('given kind password and channel browser-worker, should return ok', () => {
    const actual = decideResolveCaller({ aud: 'browser-worker', kind: 'password' });
    expect(actual).toEqual({ ok: true });
  });

  it('given kind session and channel http-executor without sessionHttp, should return kind_not_resolvable', () => {
    const actual = decideResolveCaller({ aud: 'http-executor', kind: 'session', sessionHttp: false });
    expect(actual).toEqual({ ok: false, reason: 'kind_not_resolvable' });
  });

  it('given kind session and channel http-executor with sessionHttp true, should return ok (resolveSessionOverHttp only)', () => {
    const actual = decideResolveCaller({ aud: 'http-executor', kind: 'session', sessionHttp: true });
    expect(actual).toEqual({ ok: true });
  });

  it('given kind oauth2 and channel http-executor, should return ok', () => {
    const actual = decideResolveCaller({ aud: 'http-executor', kind: 'oauth2' });
    expect(actual).toEqual({ ok: true });
  });

  it('given kind oauth2 and channel refresh-worker, should return ok', () => {
    const actual = decideResolveCaller({ aud: 'refresh-worker', kind: 'oauth2' });
    expect(actual).toEqual({ ok: true });
  });

  it('given kind api_key and channel refresh-worker, should return kind_not_resolvable', () => {
    const actual = decideResolveCaller({ aud: 'refresh-worker', kind: 'api_key' });
    expect(actual).toEqual({ ok: false, reason: 'kind_not_resolvable' });
  });

  it('given kind api_key and channel relay-runner, should return ok', () => {
    const actual = decideResolveCaller({ aud: 'relay-runner', kind: 'api_key' });
    expect(actual).toEqual({ ok: true });
  });
});
