/**
 * `decideSign` — may the server MINT a grant for this op on this env? The
 * server's say in the three-way intersection (invariant 4), enforced at the
 * one chokepoint that matters: signing. Refusing to mint beats asking a daemon
 * we do not control to refuse what we minted.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decideSign, SIGN_DENY_ORDER, type DecideSignInput } from '../decide-sign';

const base: DecideSignInput = {
  op: 'exec',
  serverPolicy: { ops: ['exec', 'fs_read'], checkpoint: false },
  envRevoked: false,
  paused: false,
  flagEnabled: true,
};

describe('decideSign — the server refuses to sign what serverPolicy does not allow', () => {
  it('given the op is in serverPolicy.ops, the env is live, not paused and the flag is on, should allow', () => {
    expect(decideSign(base)).toEqual({ ok: true });
  });

  it('given serverPolicy.ops excludes the op, should answer server_denied (before any signature could be produced — the caller signs only on ok)', () => {
    expect(decideSign({ ...base, op: 'fs_write' })).toEqual({ ok: false, reason: 'server_denied' });
  });

  it('given serverPolicy is null (missing sibling policy, or one the parser refused), should answer server_denied — fail closed, never a permissive default', () => {
    expect(decideSign({ ...base, serverPolicy: null })).toEqual({ ok: false, reason: 'server_denied' });
  });

  it('given an EMPTY ops list (the DB backstop default), should answer server_denied for every op', () => {
    for (const op of ['exec', 'fs_read', 'fs_write', 'pty_open'] as const) {
      expect(decideSign({ ...base, op, serverPolicy: { ops: [], checkpoint: false } })).toEqual({ ok: false, reason: 'server_denied' });
    }
  });

  it('given the env row has revokedAt, should answer revoked ahead of server_denied', () => {
    expect(decideSign({ ...base, envRevoked: true, serverPolicy: { ops: [], checkpoint: false } })).toEqual({ ok: false, reason: 'revoked' });
  });

  it('given LOCAL_ENVS_ENABLED is off, should answer flag_disabled first — before revocation, pause or policy are weighed', () => {
    expect(decideSign({ ...base, flagEnabled: false, envRevoked: true, paused: true, serverPolicy: null })).toEqual({ ok: false, reason: 'flag_disabled' });
  });

  it('given paused (reserved now for the Stop button), should answer paused after revoked and before server_denied', () => {
    expect(decideSign({ ...base, paused: true })).toEqual({ ok: false, reason: 'paused' });
    expect(decideSign({ ...base, paused: true, serverPolicy: null })).toEqual({ ok: false, reason: 'paused' });
  });

  it('given paused is omitted, should treat the env as not paused', () => {
    const { paused: _paused, ...withoutPaused } = base;
    expect(decideSign(withoutPaused)).toEqual({ ok: true });
  });

  it('SIGN_DENY_ORDER is the documented order', () => {
    expect(SIGN_DENY_ORDER).toEqual(['flag_disabled', 'revoked', 'paused', 'server_denied']);
  });

  it('should enforce the deny order for EVERY adjacent pair (each row breaks two adjacent gates and expects the earlier)', () => {
    const breakers: ReadonlyArray<[string, (i: DecideSignInput) => DecideSignInput]> = [
      ['flag_disabled', (i) => ({ ...i, flagEnabled: false })],
      ['revoked', (i) => ({ ...i, envRevoked: true })],
      ['paused', (i) => ({ ...i, paused: true })],
      ['server_denied', (i) => ({ ...i, serverPolicy: { ops: [], checkpoint: false } })],
    ];
    expect(breakers.map(([name]) => name)).toEqual([...SIGN_DENY_ORDER]);
    for (let n = 0; n + 1 < breakers.length; n += 1) {
      const [earlier, breakEarlier] = breakers[n] as [string, (i: DecideSignInput) => DecideSignInput];
      const [later, breakLater] = breakers[n + 1] as [string, (i: DecideSignInput) => DecideSignInput];
      const verdict = decideSign(breakEarlier(breakLater(base)));
      expect(verdict.ok, `${earlier} must beat ${later}`).toBe(false);
      if (!verdict.ok) expect(verdict.reason, `${earlier} must beat ${later}`).toBe(earlier);
    }
  });

  it('should be pure: identical inputs yield identical verdicts and the input is not mutated', () => {
    const frozen = Object.freeze({ ...base, serverPolicy: Object.freeze({ ...base.serverPolicy!, ops: Object.freeze([...base.serverPolicy!.ops]) }) });
    expect(decideSign(frozen)).toEqual(decideSign(frozen));
    expect(frozen).toEqual(base);
  });

  it('should import no I/O, clock or crypto — every input is injected (pure core rule)', () => {
    const source = readFileSync(join(__dirname, '..', 'decide-sign.ts'), 'utf8');
    for (const banned of ["from 'ws'", "from 'node:fs'", "from 'fs'", 'child_process', 'node:crypto', 'Date.now', 'new Date(', 'Math.random', 'process.env']) {
      expect(source, `decide-sign.ts must not contain ${banned}`).not.toContain(banned);
    }
    expect(source).toMatch(/^import type .* from '\.\/grant';$/m);
  });
});
