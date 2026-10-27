import { describe, it, expect } from 'vitest';
import { DRIVE_ENV_BIND_POLICIES } from '@pagespace/db/schema/drive-env-local';
import { decideBind, BIND_DENY_ORDER, type DecideBindInput } from '../decide-bind';

const base: DecideBindInput = {
  canRunCode: { ok: true },
  bindPolicy: 'owner',
  actorId: 'user_owner',
  env: { ownerId: 'user_owner', substrate: 'local', revokedAt: null },
  serverPolicy: { ops: ['fs_read', 'fs_write'], checkpoint: false },
  connected: true,
  flagEnabled: true,
};

describe('decideBind — may this actor bind a session to this local env? (invariant 11; necessary, never sufficient — the daemon still decides)', () => {
  it('given the env OWNER with everything in order, should allow', () => {
    expect(decideBind(base)).toEqual({ ok: true });
  });

  it('given flagEnabled false, should deny flag_disabled before any other check', () => {
    expect(decideBind({ ...base, flagEnabled: false, canRunCode: { ok: false, reason: 'kill_switch_off' } })).toEqual({ ok: false, reason: 'flag_disabled' });
  });

  it('given canRunCode denied, should deny code_exec_denied (the base gate is never bypassed) and carry the underlying reason', () => {
    const verdict = decideBind({ ...base, canRunCode: { ok: false, reason: 'tier_ineligible' } });
    expect(verdict).toEqual({ ok: false, reason: 'code_exec_denied', cause: 'tier_ineligible' });
  });

  it('given substrate !== local, should deny not_local (Sprite envs keep their existing path)', () => {
    expect(decideBind({ ...base, env: { ...base.env, substrate: 'sprite' } })).toEqual({ ok: false, reason: 'not_local' });
  });

  it('given revokedAt set, should deny revoked regardless of policy or connection', () => {
    expect(decideBind({ ...base, env: { ...base.env, revokedAt: 1 }, actorId: 'user_owner', bindPolicy: 'owner' })).toEqual({ ok: false, reason: 'revoked' });
  });

  it('given connected false, should deny not_connected (a bind never queues on a dead machine)', () => {
    expect(decideBind({ ...base, connected: false })).toEqual({ ok: false, reason: 'not_connected' });
  });

  describe('bindPolicy — a machine is driven by its OWNER only ([D-6], invariant 13): structural, not configurable', () => {
    it('owner: the env OWNER may bind; anyone else may not — there is no role that changes this', () => {
      expect(decideBind({ ...base, bindPolicy: 'owner', actorId: 'user_owner' })).toEqual({ ok: true });
      expect(decideBind({ ...base, bindPolicy: 'owner', actorId: 'user_admin' })).toEqual({ ok: false, reason: 'bind_policy' });
      expect(decideBind({ ...base, bindPolicy: 'owner', actorId: 'user_driveowner' })).toEqual({ ok: false, reason: 'bind_policy' });
    });

    it('the input carries NO actor role: the decision cannot be widened by one', () => {
      expect(Object.keys(base)).not.toContain('actorRole');
      expect(decideBind({ ...base, actorId: 'user_admin', actorRole: 'admin' } as DecideBindInput)).toEqual({ ok: false, reason: 'bind_policy' });
    });

    it.each(['admins', 'members'])("a row somehow still holding the REMOVED value %s (drift from before D-6) is denied for a non-owner — the default branch, never a grant", (removed) => {
      expect(decideBind({ ...base, bindPolicy: removed as never, actorId: 'user_admin' })).toEqual({ ok: false, reason: 'bind_policy' });
      expect(decideBind({ ...base, bindPolicy: removed as never, actorId: 'user_member' })).toEqual({ ok: false, reason: 'bind_policy' });
      // The owner still passes on their own machine, whatever the column says.
      expect(decideBind({ ...base, bindPolicy: removed as never, actorId: 'user_owner' })).toEqual({ ok: true });
    });

    it('an unknown bindPolicy value (a hostile or drifted row) should deny bind_policy, never allow', () => {
      expect(decideBind({ ...base, bindPolicy: 'everyone' as never, actorId: 'user_member' })).toEqual({ ok: false, reason: 'bind_policy' });
    });

    it('DRIVE_ENV_BIND_POLICIES (the schema) and BindPolicy (the gate) agree: only owner', () => {
      expect([...DRIVE_ENV_BIND_POLICIES]).toEqual(['owner']);
    });
  });

  describe('no_server_ops — a machine PageSpace may ask nothing of is refused at bind, not at every later grant (GA wave 1)', () => {
    it('given serverPolicy.ops is empty (the DB backstop default), should deny no_server_ops', () => {
      expect(decideBind({ ...base, serverPolicy: { ops: [], checkpoint: false } })).toEqual({ ok: false, reason: 'no_server_ops' });
    });

    it('given serverPolicy is null (missing, or refused by the strict parser), should deny no_server_ops — drift never widens', () => {
      expect(decideBind({ ...base, serverPolicy: null })).toEqual({ ok: false, reason: 'no_server_ops' });
    });

    it('given at least one op, should allow — WHICH op is the signing gate\'s question, not the bind gate\'s', () => {
      expect(decideBind({ ...base, serverPolicy: { ops: ['exec'], checkpoint: false } })).toEqual({ ok: true });
    });

    it('should come AFTER bind_policy: a stranger to a no-op machine learns bind_policy, never the policy state', () => {
      expect(decideBind({ ...base, bindPolicy: 'owner', actorId: 'user_stranger', serverPolicy: { ops: [], checkpoint: false } })).toEqual({ ok: false, reason: 'bind_policy' });
    });
  });

  it('BIND_DENY_ORDER is the documented order, no_server_ops LAST', () => {
    expect(BIND_DENY_ORDER).toEqual(['flag_disabled', 'code_exec_denied', 'not_local', 'revoked', 'not_connected', 'bind_policy', 'no_server_ops']);
  });

  it('should enforce the deny order for EVERY adjacent pair (each row breaks two adjacent gates and expects the earlier)', () => {
    const breakers: ReadonlyArray<[string, (i: DecideBindInput) => DecideBindInput]> = [
      ['flag_disabled', (i) => ({ ...i, flagEnabled: false })],
      ['code_exec_denied', (i) => ({ ...i, canRunCode: { ok: false, reason: 'tier_ineligible' } })],
      ['not_local', (i) => ({ ...i, env: { ...i.env, substrate: 'sprite' } })],
      ['revoked', (i) => ({ ...i, env: { ...i.env, revokedAt: 1 } })],
      ['not_connected', (i) => ({ ...i, connected: false })],
      ['bind_policy', (i) => ({ ...i, actorId: 'user_stranger' })],
      ['no_server_ops', (i) => ({ ...i, serverPolicy: { ops: [], checkpoint: false } })],
    ];
    expect(breakers.map(([name]) => name)).toEqual([...BIND_DENY_ORDER]);
    for (let n = 0; n + 1 < breakers.length; n += 1) {
      const [earlier, breakEarlier] = breakers[n] as [string, (i: DecideBindInput) => DecideBindInput];
      const [later, breakLater] = breakers[n + 1] as [string, (i: DecideBindInput) => DecideBindInput];
      const verdict = decideBind(breakEarlier(breakLater(base)));
      expect(verdict.ok, `${earlier} must beat ${later}`).toBe(false);
      if (!verdict.ok) expect(verdict.reason, `${earlier} must beat ${later}`).toBe(earlier);
    }
  });

  it('should be pure: identical inputs yield identical verdicts and the input is not mutated', () => {
    const frozen = Object.freeze({ ...base, env: Object.freeze({ ...base.env }) });
    expect(decideBind(frozen)).toEqual(decideBind(frozen));
    expect(frozen).toEqual(base);
  });
});
