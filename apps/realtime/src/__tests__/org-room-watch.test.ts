import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { credentialActor } from '@pagespace/lib/permissions/access-actor';
import { createOrgRoomWatch, createPolicyChangeFanout, ORG_REAUTHENTICATION_REQUIRED_EVENT, type OrgRoomWatch } from '../org-room-watch';

const T0 = Date.parse('2026-10-12T12:00:00Z');
const minutes = (n: number) => n * 60_000;

function setup(policies: Record<string, { requireStrongSignIn: boolean; maximumSessionAgeMinutes: number | null } | null>) {
  const socket = {
    data: { actor: credentialActor('user-1', { authenticatedAtMs: T0, assurance: 'single_factor' }) },
    leave: vi.fn(),
    emit: vi.fn(),
  };
  const onLeft = vi.fn();
  const current = { ...policies };
  const watch = createOrgRoomWatch(socket, {
    readPolicies: async (ids) => new Map(ids.map((id) => [id, current[id] ?? null])),
    onLeft,
    now: () => Date.now(),
    setTimer: (run, delay) => setTimeout(run, delay),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    onError: vi.fn(),
  });
  return { socket, onLeft, watch, current };
}

describe('org room watch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => vi.useRealTimers());

  it("SEC-3 (partial) a socket past the org's maximum age is evicted from that org's rooms, and only those", async () => {
    const { socket, onLeft, watch } = setup({ 'org-drive': { requireStrongSignIn: false, maximumSessionAgeMinutes: 15 }, 'personal-drive': null });
    await watch.track('drive:org-drive', 'org-drive');
    await watch.track('drive:personal-drive', 'personal-drive');

    await vi.advanceTimersByTimeAsync(minutes(15) - 1);
    expect(socket.leave).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(socket.leave).toHaveBeenCalledTimes(1);
    expect(socket.leave).toHaveBeenCalledWith('drive:org-drive');
    expect(onLeft).toHaveBeenCalledWith('drive:org-drive');
    expect(socket.emit).toHaveBeenCalledWith(ORG_REAUTHENTICATION_REQUIRED_EVENT, { code: 'org_reauthentication_required', resourceId: 'org-drive' });
  });

  it('SEC-3 (partial) the timer re-arms for the next earliest org expiry after an eviction', async () => {
    const { socket, watch } = setup({
      a: { requireStrongSignIn: false, maximumSessionAgeMinutes: 15 },
      b: { requireStrongSignIn: false, maximumSessionAgeMinutes: 60 },
    });
    await watch.track('drive:a', 'a');
    await watch.track('drive:b', 'b');
    await vi.advanceTimersByTimeAsync(minutes(15));
    expect(socket.leave.mock.calls).toEqual([['drive:a']]);
    await vi.advanceTimersByTimeAsync(minutes(45));
    expect(socket.leave.mock.calls).toEqual([['drive:a'], ['drive:b']]);
  });

  it('SEC-2 (partial) a policy change that now requires strong sign-in evicts the single-factor socket on recheck', async () => {
    const { socket, watch, current } = setup({ d: { requireStrongSignIn: false, maximumSessionAgeMinutes: null } });
    await watch.track('drive:d', 'd');
    expect(socket.leave).not.toHaveBeenCalled();
    current.d = { requireStrongSignIn: true, maximumSessionAgeMinutes: null };
    await watch.recheck();
    expect(socket.emit).toHaveBeenCalledWith(ORG_REAUTHENTICATION_REQUIRED_EVENT, { code: 'org_strong_sign_in_required', resourceId: 'd' });
  });

  it('a left room is no longer watched, and dispose clears the timer', async () => {
    const { socket, watch } = setup({ d: { requireStrongSignIn: false, maximumSessionAgeMinutes: 15 } });
    await watch.track('drive:d', 'd');
    watch.untrack('drive:d');
    watch.dispose();
    await vi.advanceTimersByTimeAsync(minutes(30));
    expect(socket.leave).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  describe('policy-change fan-out', () => {
    it("SEC-2 (partial) an org's policy change re-decides EVERY watch on the process: a guest (not an org member, so never sent org:changed) is evicted from the org drive's room at once", async () => {
      const member = setup({ d: { requireStrongSignIn: false, maximumSessionAgeMinutes: null } });
      const guest = setup({ d: { requireStrongSignIn: false, maximumSessionAgeMinutes: null } });
      await member.watch.track('drive:d', 'd');
      await guest.watch.track('drive:d', 'd');
      const watches = new Map<string, OrgRoomWatch>([['member-socket', member.watch], ['guest-socket', guest.watch]]);
      const fanOut = createPolicyChangeFanout({ watches: () => watches.values(), now: () => Date.now(), windowMs: 1_000 });

      member.current.d = { requireStrongSignIn: true, maximumSessionAgeMinutes: null };
      guest.current.d = { requireStrongSignIn: true, maximumSessionAgeMinutes: null };
      fanOut('org-1');
      await vi.advanceTimersByTimeAsync(0);

      expect(guest.socket.leave).toHaveBeenCalledWith('drive:d');
      expect(guest.socket.emit).toHaveBeenCalledWith(ORG_REAUTHENTICATION_REQUIRED_EVENT, { code: 'org_strong_sign_in_required', resourceId: 'd' });
      expect(member.socket.leave).toHaveBeenCalledWith('drive:d');
    });

    it('SEC-2 (partial) the per-member org:changed repeats for one org are folded into one fan-out within the window; a later change fans out again', () => {
      const recheck = vi.fn(async () => {});
      const watch: OrgRoomWatch = { track: vi.fn(async () => {}), untrack: vi.fn(), recheck, dispose: vi.fn() };
      const fanOut = createPolicyChangeFanout({ watches: () => [watch], now: () => Date.now(), windowMs: 1_000 });

      fanOut('org-1');
      fanOut('org-1');
      fanOut('org-1');
      expect(recheck).toHaveBeenCalledTimes(1);

      fanOut('org-2');
      expect(recheck).toHaveBeenCalledTimes(2);

      vi.setSystemTime(T0 + 1_000);
      fanOut('org-1');
      expect(recheck).toHaveBeenCalledTimes(3);
    });
  });
});
