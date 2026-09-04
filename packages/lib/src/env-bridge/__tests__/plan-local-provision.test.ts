import { describe, it, expect } from 'vitest';
import { planLocalProvision } from '../plan-local-provision';

const local = { id: 'env_1', substrate: 'local' as const, revokedAt: null };

describe('planLocalProvision — a local env maps to a typed verdict and never falls through to the Sprite path', () => {
  it('given a local env that is connected, should attach_local with the envId', () => {
    expect(planLocalProvision({ env: local, connected: true })).toEqual({ kind: 'attach_local', envId: 'env_1' });
  });

  it('given a local env that is disconnected, should return not_connected (a typed verdict, never a Sprite provision)', () => {
    expect(planLocalProvision({ env: local, connected: false })).toEqual({ kind: 'not_connected' });
  });

  it('given a non-local env, should return not_local regardless of connection (the caller keeps its Sprite path)', () => {
    expect(planLocalProvision({ env: { ...local, substrate: 'sprite' }, connected: true })).toEqual({ kind: 'not_local' });
    expect(planLocalProvision({ env: { ...local, substrate: 'sprite' }, connected: false })).toEqual({ kind: 'not_local' });
  });

  it('given a revoked local env, should return revoked even if a socket is still open (fail closed; the row wins over the socket)', () => {
    expect(planLocalProvision({ env: { ...local, revokedAt: 1 }, connected: true })).toEqual({ kind: 'revoked' });
  });

  it('given an unknown substrate value (a drifted row), should return not_local, never attach', () => {
    expect(planLocalProvision({ env: { ...local, substrate: 'modal' as never }, connected: true })).toEqual({ kind: 'not_local' });
  });

  it('should be pure and never mutate its input', () => {
    const frozen = Object.freeze({ env: Object.freeze({ ...local }), connected: true });
    expect(planLocalProvision(frozen)).toEqual(planLocalProvision(frozen));
  });
});
