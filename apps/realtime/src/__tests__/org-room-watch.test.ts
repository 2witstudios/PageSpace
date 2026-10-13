import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { credentialActor } from '@pagespace/lib/permissions/access-actor';
import { createOrgRoomWatch, createPolicyChangeFanout, ORG_REAUTHENTICATION_REQUIRED_EVENT } from '../org-room-watch';

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

  it('SEC-3 (partial) a failed policy read reports the error and retries a minute later, still watching held rooms', async () => {
    const socket = {
      data: { actor: credentialActor('user-1', { authenticatedAtMs: T0, assurance: 'single_factor' as const }) },
      leave: vi.fn(),
      emit: vi.fn(),
    };
    const onError = vi.fn();
    let failing = true;
    const watch = createOrgRoomWatch(socket, {
      readPolicies: async (ids) => {
        if (failing) throw new Error('policy read failed');
        return new Map(ids.map((id) => [id, { requireStrongSignIn: true, maximumSessionAgeMinutes: null }]));
      },
      onLeft: vi.fn(),
      now: () => Date.now(),
      setTimer: (run, delay) => setTimeout(run, delay),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      onError,
    });
    await watch.track('drive:d', 'd');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(socket.leave).not.toHaveBeenCalled();
    failing = false;
    await vi.advanceTimersByTimeAsync(minutes(1));
    expect(socket.leave).toHaveBeenCalledWith('drive:d');
  });

  it('SEC-3 enforces last known expiry despite failed reads, retaining a still-valid room until its deadline', async () => {
    const socket = {
      data: { actor: credentialActor('user-1', { authenticatedAtMs: T0, assurance: 'single_factor' as const }) },
      leave: vi.fn(), emit: vi.fn(),
    };
    let failing = false;
    const watch = createOrgRoomWatch(socket, {
      readPolicies: async () => {
        if (failing) throw new Error('policy read failed');
        return new Map([['d', { requireStrongSignIn: false, maximumSessionAgeMinutes: 15 }]]);
      },
      onLeft: vi.fn(), now: () => Date.now(),
      setTimer: (run, delay) => setTimeout(run, delay),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>), onError: vi.fn(),
    });
    await watch.track('drive:d', 'd');
    failing = true;
    await vi.advanceTimersByTimeAsync(minutes(15) - 1);
    await watch.recheck();
    expect(socket.leave).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.leave.mock.calls).toEqual([['drive:d']]);
    expect(socket.emit).toHaveBeenCalledWith(ORG_REAUTHENTICATION_REQUIRED_EVENT, { code: 'org_reauthentication_required', resourceId: 'd' });
    await vi.advanceTimersByTimeAsync(minutes(2));
    expect(socket.leave).toHaveBeenCalledTimes(1);
  });

  it('a watch disposed while its policy read is in flight leaves nothing and arms nothing', async () => {
    const socket = { data: { actor: credentialActor('user-1', null) }, leave: vi.fn(), emit: vi.fn() };
    let release: (value: Map<string, { requireStrongSignIn: boolean; maximumSessionAgeMinutes: number | null } | null>) => void = () => {};
    const watch = createOrgRoomWatch(socket, {
      readPolicies: () => new Promise((resolve) => { release = resolve; }),
      onLeft: vi.fn(),
      now: () => Date.now(),
      setTimer: (run, delay) => setTimeout(run, delay),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      onError: vi.fn(),
    });
    const tracking = watch.track('drive:d', 'd');
    await Promise.resolve();
    watch.dispose();
    release(new Map([['d', { requireStrongSignIn: true, maximumSessionAgeMinutes: null }]]));
    await tracking;
    expect(socket.leave).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a failed read with no rooms left arms no retry', async () => {
    const socket = { data: { actor: credentialActor('user-1', null) }, leave: vi.fn(), emit: vi.fn() };
    const watch = createOrgRoomWatch(socket, {
      readPolicies: async () => { throw new Error('policy read failed'); },
      onLeft: vi.fn(),
      now: () => Date.now(),
      setTimer: (run, delay) => setTimeout(run, delay),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      onError: vi.fn(),
    });
    const tracking = watch.track('drive:d', 'd');
    watch.untrack('drive:d');
    await tracking;
    expect(vi.getTimerCount()).toBe(0);
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

    it('SEC-2 distinct same-org changes within 100ms both recheck and tightening evicts', async () => {
      const { socket, watch, current } = setup({ d: { requireStrongSignIn: false, maximumSessionAgeMinutes: null } });
      await watch.track('drive:d', 'd');
      const fanOut = createPolicyChangeFanout({ watches: () => [watch], now: () => Date.now(), windowMs: 1_000 });
      fanOut('org-1');
      await vi.advanceTimersByTimeAsync(100);
      current.d = { requireStrongSignIn: true, maximumSessionAgeMinutes: null };
      fanOut('org-1');
      await vi.advanceTimersByTimeAsync(0);
      expect(socket.leave).toHaveBeenCalledWith('drive:d');
      expect(socket.emit).toHaveBeenCalledWith(ORG_REAUTHENTICATION_REQUIRED_EVENT, { code: 'org_strong_sign_in_required', resourceId: 'd' });
    });

    it('SEC-2 a tightening notice during an earlier lookup is checked after that lookup finishes', async () => {
      const socket = {
        data: { actor: credentialActor('user-1', { authenticatedAtMs: T0, assurance: 'single_factor' as const }) },
        leave: vi.fn(), emit: vi.fn(),
      };
      let strong = false;
      let pause = false;
      let release: () => void = () => {};
      const watch = createOrgRoomWatch(socket, {
        readPolicies: async () => {
          const policy = { requireStrongSignIn: strong, maximumSessionAgeMinutes: null };
          if (pause) {
            pause = false;
            await new Promise<void>((resolve) => { release = resolve; });
          }
          return new Map([['d', policy]]);
        },
        onLeft: vi.fn(), now: () => Date.now(),
        setTimer: (run, delay) => setTimeout(run, delay),
        clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>), onError: vi.fn(),
      });
      await watch.track('drive:d', 'd');
      const fanOut = createPolicyChangeFanout({ watches: () => [watch], now: () => Date.now(), windowMs: 1_000 });
      pause = true;
      fanOut('org-1');
      await Promise.resolve();
      strong = true;
      fanOut('org-1');
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(socket.leave).toHaveBeenCalledWith('drive:d');
      expect(socket.emit).toHaveBeenCalledWith(ORG_REAUTHENTICATION_REQUIRED_EVENT, { code: 'org_strong_sign_in_required', resourceId: 'd' });
    });
  });
});
