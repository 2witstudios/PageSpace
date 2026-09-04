import { describe, it, expect } from 'vitest';
import { decideBind, BIND_DENY_ORDER, type DecideBindInput } from '../decide-bind';

const base: DecideBindInput = {
  canRunCode: { ok: true },
  bindPolicy: 'members',
  actorRole: 'member',
  actorId: 'user_member',
  env: { ownerId: 'user_owner', substrate: 'local', revokedAt: null },
  connected: true,
  flagEnabled: true,
};

describe('decideBind — may this actor bind a session to this local env? (invariant 11; necessary, never sufficient — the daemon still decides)', () => {
  it('given everything in order under bindPolicy members, should allow', () => {
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

  describe('bindPolicy', () => {
    it("owner: the env OWNER may bind; a drive admin who is not the env owner may not", () => {
      expect(decideBind({ ...base, bindPolicy: 'owner', actorId: 'user_owner', actorRole: 'member' })).toEqual({ ok: true });
      expect(decideBind({ ...base, bindPolicy: 'owner', actorId: 'user_admin', actorRole: 'admin' })).toEqual({ ok: false, reason: 'bind_policy' });
      expect(decideBind({ ...base, bindPolicy: 'owner', actorId: 'user_driveowner', actorRole: 'owner' })).toEqual({ ok: false, reason: 'bind_policy' });
    });

    it('admins: a drive admin or drive owner may bind; a member may not; the env owner always may', () => {
      expect(decideBind({ ...base, bindPolicy: 'admins', actorRole: 'admin', actorId: 'user_admin' })).toEqual({ ok: true });
      expect(decideBind({ ...base, bindPolicy: 'admins', actorRole: 'owner', actorId: 'user_driveowner' })).toEqual({ ok: true });
      expect(decideBind({ ...base, bindPolicy: 'admins', actorRole: 'member', actorId: 'user_member' })).toEqual({ ok: false, reason: 'bind_policy' });
      expect(decideBind({ ...base, bindPolicy: 'admins', actorRole: 'member', actorId: 'user_owner' })).toEqual({ ok: true });
    });

    it('members: any actor who passed canRunCode may bind', () => {
      expect(decideBind({ ...base, bindPolicy: 'members', actorRole: 'member' })).toEqual({ ok: true });
    });

    it('an unknown bindPolicy value (a hostile or drifted row) should deny bind_policy, never allow', () => {
      expect(decideBind({ ...base, bindPolicy: 'everyone' as never })).toEqual({ ok: false, reason: 'bind_policy' });
    });
  });

  it('BIND_DENY_ORDER is the documented order', () => {
    expect(BIND_DENY_ORDER).toEqual(['flag_disabled', 'code_exec_denied', 'not_local', 'revoked', 'not_connected', 'bind_policy']);
  });

  it('should enforce the deny order for EVERY adjacent pair (each row breaks two adjacent gates and expects the earlier)', () => {
    const breakers: ReadonlyArray<[string, (i: DecideBindInput) => DecideBindInput]> = [
      ['flag_disabled', (i) => ({ ...i, flagEnabled: false })],
      ['code_exec_denied', (i) => ({ ...i, canRunCode: { ok: false, reason: 'tier_ineligible' } })],
      ['not_local', (i) => ({ ...i, env: { ...i.env, substrate: 'sprite' } })],
      ['revoked', (i) => ({ ...i, env: { ...i.env, revokedAt: 1 } })],
      ['not_connected', (i) => ({ ...i, connected: false })],
      ['bind_policy', (i) => ({ ...i, bindPolicy: 'owner', actorId: 'user_stranger' })],
    ];
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
