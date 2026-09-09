/**
 * `gateLocalEnv` — the server-side gate every entry point runs for a LOCAL env
 * (Codex C1). The pure planners have their own matrices; what this suite pins
 * is that the gate feeds them the REAL facts (sibling, heartbeat/socket
 * reading, code-exec verdict, role, flag) in the documented order, and that it
 * never invents a verdict of its own.
 */
import { describe, it, expect } from 'vitest';
import { gateLocalEnv, type LocalEnvGateDeps } from '../local-env-gate';
import { LOCAL_ENV_HEARTBEAT_WINDOW_MS } from '../drive-envs';
import { makeLocalRecord, ENV_ID, NOW } from './fakes';
import type { DriveEnvLocalRecord } from '../drive-envs-store';

const OWNER = 'user-1';
const row = { id: ENV_ID, substrate: 'local' as const };

function enrolledSibling(over: Partial<DriveEnvLocalRecord> = {}): DriveEnvLocalRecord {
  return makeLocalRecord({ ownerId: OWNER, enrolledAt: NOW, machinePublicKey: 'pk', machineKeyFingerprint: 'fp', serverKeyId: 'k1', lastSeenAt: NOW, ...over });
}

function deps(over: Partial<LocalEnvGateDeps> & { sibling?: DriveEnvLocalRecord | null } = {}): LocalEnvGateDeps {
  const { sibling = enrolledSibling(), ...rest } = over;
  return {
    store: { findLocalByEnvId: async () => sibling },
    canRunCode: async () => ({ ok: true }),
    liveConnection: () => null,
    flagEnabled: true,
    now: () => NOW,
    ...rest,
  };
}

const gate = (over: Parameters<typeof deps>[0] = {}, requesterId = OWNER) => gateLocalEnv({ row, requesterId, deps: deps(over) });

describe('gateLocalEnv — the real facts, handed to decideBind then planLocalProvision', () => {
  it('given the owner, an enrolled machine with a fresh heartbeat, the flag on and code exec allowed, should allow (attach_local)', async () => {
    expect(await gate()).toEqual({ ok: true, envId: ENV_ID });
  });

  it('given no sibling row (owner erased — a dead local env), should refuse revoked without consulting anything else', async () => {
    let asked = false;
    expect(await gate({ sibling: null, canRunCode: async () => { asked = true; return { ok: true }; } })).toEqual({ ok: false, refusal: 'revoked' });
    expect(asked).toBe(false);
  });

  it('given LOCAL_ENVS_ENABLED off, should refuse flag_disabled FIRST — before code exec, connection or policy are weighed', async () => {
    expect(await gate({ flagEnabled: false, canRunCode: async () => ({ ok: false, reason: 'no_drive_access' }), sibling: enrolledSibling({ revokedAt: NOW }) })).toEqual({ ok: false, refusal: 'flag_disabled' });
  });

  it("given canRunCode denies, should refuse code_exec_denied carrying the gate's own cause", async () => {
    expect(await gate({ canRunCode: async () => ({ ok: false, reason: 'tier_ineligible' }) })).toEqual({ ok: false, refusal: 'code_exec_denied', cause: 'tier_ineligible' });
  });

  it('given a revoked sibling, should refuse revoked even with a live socket (the row wins over the socket)', async () => {
    expect(await gate({ sibling: enrolledSibling({ revokedAt: NOW }), liveConnection: () => 'connected' })).toEqual({ ok: false, refusal: 'revoked' });
  });

  it('given no live socket and a heartbeat older than the window, should refuse not_connected', async () => {
    const stale = new Date(NOW.getTime() - LOCAL_ENV_HEARTBEAT_WINDOW_MS - 1);
    expect(await gate({ sibling: enrolledSibling({ lastSeenAt: stale }) })).toEqual({ ok: false, refusal: 'not_connected' });
  });

  it('given a never-connected machine (no heartbeat, no socket), should refuse not_connected', async () => {
    expect(await gate({ sibling: enrolledSibling({ lastSeenAt: null }) })).toEqual({ ok: false, refusal: 'not_connected' });
  });

  it('given a live socket on THIS replica, should count as connected even with no heartbeat yet', async () => {
    expect(await gate({ sibling: enrolledSibling({ lastSeenAt: null }), liveConnection: () => 'connected' })).toEqual({ ok: true, envId: ENV_ID });
  });

  it('given a socket still mid-handshake (connecting), should refuse not_connected — a bind never queues on a machine that has not proven itself', async () => {
    expect(await gate({ sibling: enrolledSibling({ lastSeenAt: null }), liveConnection: () => 'connecting' })).toEqual({ ok: false, refusal: 'not_connected' });
  });

  it('given a not-yet-enrolled sibling (code issued, key never pinned), should refuse not_connected', async () => {
    expect(await gate({ sibling: makeLocalRecord({ ownerId: OWNER, enrolledAt: null, lastSeenAt: NOW }) })).toEqual({ ok: false, refusal: 'not_connected' });
  });

  describe('bindPolicy — the env OWNER only ([D-6], invariant 13); no drive role is ever resolved', () => {
    it('a drive admin who did not enroll the machine is refused bind_policy', async () => {
      expect(await gate({}, 'admin-2')).toEqual({ ok: false, refusal: 'bind_policy' });
    });

    it.each(['admins', 'members', 'everyone'])('a row holding %s (a removed or hostile value) denies a non-owner — drift never grants', async (value) => {
      expect(await gate({ sibling: enrolledSibling({ bindPolicy: value }) }, 'member-3')).toEqual({ ok: false, refusal: 'bind_policy' });
    });

    it('the gate has NO role resolver to inject: there is no seam through which a role could widen the answer', () => {
      expect(Object.keys(deps())).not.toContain('resolveActorRole');
    });
  });

  describe('short-circuit order — no IO that cannot change the verdict (Codex P2 on #2537)', () => {
    const throwingCanRun = async (): Promise<{ ok: true }> => {
      throw new Error('canRunCode must not be reached');
    };

    it('given the flag off, should refuse flag_disabled WITHOUT calling canRunCode', async () => {
      expect(await gate({ flagEnabled: false, canRunCode: throwingCanRun })).toEqual({ ok: false, refusal: 'flag_disabled' });
    });

    it('given canRunCode denies, should refuse code_exec_denied', async () => {
      expect(await gate({ canRunCode: async () => ({ ok: false, reason: 'no_drive_access' }) })).toEqual({ ok: false, refusal: 'code_exec_denied', cause: 'no_drive_access' });
    });

    it('given a revoked or disconnected machine, should refuse with the machine\'s word', async () => {
      expect(await gate({ sibling: enrolledSibling({ revokedAt: NOW }) })).toEqual({ ok: false, refusal: 'revoked' });
      expect(await gate({ sibling: enrolledSibling({ lastSeenAt: null }) })).toEqual({ ok: false, refusal: 'not_connected' });
    });
  });

  it('should pass the REQUESTER as the actor — not the row owner — so the owner check is real', async () => {
    // Same machine, two requesters: the owner passes under owner-only, a stranger does not.
    expect(await gate({}, OWNER)).toEqual({ ok: true, envId: ENV_ID });
    expect(await gate({}, 'stranger')).toEqual({ ok: false, refusal: 'bind_policy' });
  });
});
