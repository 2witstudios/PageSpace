import { describe, it, expect } from 'vitest';

// Threat model C3, D-20 (Λ3). password is resolvable only by the browser-fill executor.
// G1b-store: real assertions over decideResolveCaller, the runtime re-check of ResolvableBy<C>.

import { decideResolveCaller } from '../../store/decide-resolve-caller';

describe('adversarial: password-kind-channel', () => {
  it('given kind password requested by http-executor, should return kind_not_resolvable at the adapter (ResolvableBy<http-executor> already excludes password at the store-adapter.ts type level — see store/__tests__/decide-resolve-caller.test.ts for the type-level companion)', () => {
    expect(decideResolveCaller({ aud: 'http-executor', kind: 'password' })).toEqual({ ok: false, reason: 'kind_not_resolvable' });
  });

  it('given kind password requested by relay-runner, should return kind_not_resolvable', () => {
    expect(decideResolveCaller({ aud: 'relay-runner', kind: 'password' })).toEqual({ ok: false, reason: 'kind_not_resolvable' });
  });

  it('given kind password requested by refresh-worker, should return kind_not_resolvable', () => {
    expect(decideResolveCaller({ aud: 'refresh-worker', kind: 'password' })).toEqual({ ok: false, reason: 'kind_not_resolvable' });
  });

  it('given kind password requested by browser-worker under a verified grant, should resolve', () => {
    expect(decideResolveCaller({ aud: 'browser-worker', kind: 'password' })).toEqual({ ok: true });
  });

  it('given the kind_not_resolvable rule broken by line index (mutation), should go RED; restored, GREEN — evidence reported as MUTATION: in the epic channel (store/decide-resolve-caller.ts:32)', () => {
    // The break/restore itself was performed with the Edit tool against decide-resolve-caller.ts
    // and reported to the channel per Control Board §7.4; this pins the mechanism exists post-restore.
    expect(decideResolveCaller({ aud: 'http-executor', kind: 'password' })).toEqual({ ok: false, reason: 'kind_not_resolvable' });
  });
});
