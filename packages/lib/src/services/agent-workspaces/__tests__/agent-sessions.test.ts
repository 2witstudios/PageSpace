import { describe, it, expect } from 'vitest';
import {
  spawnAgentSession,
  endAgentSession,
  listAgentSessions,
  toAgentSessionDTO,
  type SpawnAgentSessionDeps,
} from '../agent-sessions';
import type { AgentSessionListFilter } from '../agent-sessions-store';
import { ensureAgentSessionSandbox, type AgentSessionSpriteRow } from '../agent-session-sprite';
import { agentSessionDtoSchema } from '../../../agent-workspaces/contract';
import { deriveAgentSessionSpriteKey } from '../../../agent-workspaces/session-sprite-key';
import {
  DRIVE_ID,
  NOW,
  OWNER_ID,
  SECRET,
  SESSION_ID,
  TENANT_ID,
  makeAgentSessionStore,
  makeSessionRecord,
  makeSpriteHost,
} from './fakes';

const SESSION_KEY = deriveAgentSessionSpriteKey({ tenantId: TENANT_ID, workspaceId: SESSION_ID, secret: SECRET });

function makeSpawnDeps(
  store: ReturnType<typeof makeAgentSessionStore>,
  over: Partial<SpawnAgentSessionDeps> = {},
): SpawnAgentSessionDeps {
  return {
    store: store.store,
    now: () => NOW,
    maxActiveSessions: 100,
    ...over,
  };
}

describe('spawnAgentSession', () => {
  it('should mint a session row with its OWN id — never a conversation id', async () => {
    const store = makeAgentSessionStore();
    const result = await spawnAgentSession({ ownerId: OWNER_ID, driveId: DRIVE_ID, deps: makeSpawnDeps(store) });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.id).toBeTruthy();
    expect(result.session.driveId).toBe(DRIVE_ID);
    expect(result.session.ownerId).toBe(OWNER_ID);
    expect(store.rows.get(result.session.id)).toBeDefined();
  });

  it('should spawn WITHOUT provisioning — spawn is instant and free', async () => {
    // Lazy provisioning is the invariant: no sandbox exists until first real
    // use, so a spawned session must carry no Sprite identity at all.
    const store = makeAgentSessionStore();
    const result = await spawnAgentSession({ ownerId: OWNER_ID, driveId: DRIVE_ID, deps: makeSpawnDeps(store) });
    if (!result.ok) throw new Error('expected ok');
    expect(result.session.sandboxId).toBeNull();
    expect(result.session.spriteKey).toBeNull();
  });

  it('given two spawns, should mint two sessions — two spawns MEAN two workspaces', async () => {
    const store = makeAgentSessionStore();
    const a = await spawnAgentSession({ ownerId: OWNER_ID, driveId: DRIVE_ID, deps: makeSpawnDeps(store) });
    const b = await spawnAgentSession({ ownerId: OWNER_ID, driveId: DRIVE_ID, deps: makeSpawnDeps(store) });
    if (!a.ok || !b.ok) throw new Error('expected ok');
    expect(a.session.id).not.toBe(b.session.id);
    expect(store.rows.size).toBe(2);
  });

  it('given a null driveId, should spawn a user-scoped global-assistant session', async () => {
    const store = makeAgentSessionStore();
    const result = await spawnAgentSession({ ownerId: OWNER_ID, driveId: null, deps: makeSpawnDeps(store) });
    if (!result.ok) throw new Error('expected ok');
    expect(result.session.driveId).toBeNull();
  });

  it('should carry the display name as a LABEL, defaulting to null', async () => {
    const store = makeAgentSessionStore();
    const named = await spawnAgentSession({ ownerId: OWNER_ID, driveId: DRIVE_ID, name: 'api refactor', deps: makeSpawnDeps(store) });
    const unnamed = await spawnAgentSession({ ownerId: OWNER_ID, driveId: DRIVE_ID, deps: makeSpawnDeps(store) });
    if (!named.ok || !unnamed.ok) throw new Error('expected ok');
    expect(named.session.name).toBe('api refactor');
    expect(unnamed.session.name).toBeNull();
  });

  it('given the store insert throwing (e.g. a dead driveId FK), should report spawn_failed', async () => {
    const store = makeAgentSessionStore();
    store.store.createIfUnderLimit = async () => {
      throw new Error('violates foreign key constraint');
    };
    const result = await spawnAgentSession({ ownerId: OWNER_ID, driveId: 'no-such-drive', deps: makeSpawnDeps(store) });
    expect(result).toMatchObject({ ok: false, reason: 'spawn_failed' });
  });

  it('given the owner is AT the ceiling, should report session_limit_reached — the check a future caller cannot omit (review #2261/2)', async () => {
    const store = makeAgentSessionStore();
    const result = await spawnAgentSession({
      ownerId: OWNER_ID,
      driveId: DRIVE_ID,
      deps: makeSpawnDeps(store, { maxActiveSessions: 1 }),
    });
    expect(result.ok).toBe(true);

    const second = await spawnAgentSession({
      ownerId: OWNER_ID,
      driveId: DRIVE_ID,
      deps: makeSpawnDeps(store, { maxActiveSessions: 1 }),
    });
    expect(second).toEqual({ ok: false, reason: 'session_limit_reached' });
    expect(store.rows.size).toBe(1);
  });
});

describe('findByConversation — how a thread resolves its working context', () => {
  it('given two conversations bound to ONE session, both should resolve the SAME row', async () => {
    // The payoff of the un-conflation at the store contract: sandbox sharing is
    // structural. Both threads resolve one session, whose id folds ONE Sprite
    // key — so their tool calls land in one sandbox by construction.
    const store = makeAgentSessionStore([makeSessionRecord({ spriteKey: SESSION_KEY })]);
    store.conversationBindings.set('conv-a', SESSION_ID);
    store.conversationBindings.set('conv-b', SESSION_ID);

    const a = await store.store.findByConversation('conv-a');
    const b = await store.store.findByConversation('conv-b');

    expect(a?.id).toBe(SESSION_ID);
    expect(b?.id).toBe(SESSION_ID);
    expect(a?.spriteKey).toBe(b?.spriteKey);
  });

  it('given a thread with NO session, should resolve null — never a fallback', async () => {
    // The tool layer's no-session denial depends on this honesty: a plain chat
    // must not lazily mint a per-conversation environment, which is exactly the
    // conflation that was removed.
    const store = makeAgentSessionStore([makeSessionRecord()]);
    expect(await store.store.findByConversation('unbound-conv')).toBeNull();
  });
});

describe('endAgentSession', () => {
  const provisioned = makeSessionRecord({
    spriteKey: SESSION_KEY,
    sandboxId: SESSION_KEY,
    spriteInstanceId: 'inst-live',
  });

  function makeEndDeps(
    store: ReturnType<typeof makeAgentSessionStore>,
    host: ReturnType<typeof makeSpriteHost>,
  ) {
    return { store: store.store, host: host.host, now: () => NOW };
  }

  it('should kill the Sprite under an INSTANCE guard and stamp the row', async () => {
    const store = makeAgentSessionStore([provisioned]);
    const host = makeSpriteHost({ seed: { [SESSION_KEY]: { instanceId: 'inst-live' } } });
    const result = await endAgentSession({ workspaceId: SESSION_ID, deps: makeEndDeps(store, host) });

    expect(result).toEqual({ ok: true, spriteTornDown: true });
    expect(host.calls.kill).toEqual([{ sandboxId: SESSION_KEY, expectedInstanceId: 'inst-live' }]);
    const row = store.rows.get(SESSION_ID)!;
    expect(row.spriteTornDownAt).toEqual(NOW);
    expect(row.endedAt).toEqual(NOW);
  });

  it('should KEEP the row — a killed session is re-provisionable, not deleted', async () => {
    const store = makeAgentSessionStore([provisioned]);
    const host = makeSpriteHost({ seed: { [SESSION_KEY]: { instanceId: 'inst-live' } } });
    await endAgentSession({ workspaceId: SESSION_ID, deps: makeEndDeps(store, host) });

    expect(store.rows.has(SESSION_ID)).toBe(true);
    expect(store.rows.get(SESSION_ID)!.spriteKey).toBe(SESSION_KEY);
  });

  it('should record the teardown INTENT before the kill, so a crash in between stays reclaimable', async () => {
    const store = makeAgentSessionStore([provisioned]);
    const host = makeSpriteHost({
      seed: { [SESSION_KEY]: { instanceId: 'inst-live' } },
      killError: new Error('control plane down'),
    });
    const result = await endAgentSession({ workspaceId: SESSION_ID, deps: makeEndDeps(store, host) });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('teardown_failed');
    const row = store.rows.get(SESSION_ID)!;
    // The intent survives the failure — that stamp is the reconciler's licence.
    expect(row.teardownRequestedAt).toEqual(NOW);
    expect(row.spriteTornDownAt).toBeNull();
  });

  it('given a Sprite already replaced under the same name, should treat our target as gone and stamp', async () => {
    const store = makeAgentSessionStore([provisioned]);
    const host = makeSpriteHost({ seed: { [SESSION_KEY]: { instanceId: 'inst-someone-elses' } } });
    const result = await endAgentSession({ workspaceId: SESSION_ID, deps: makeEndDeps(store, host) });

    expect(result).toEqual({ ok: true, spriteTornDown: true });
    // The replacement is NOT destroyed — the host refused, and we did not retry
    // without the guard.
    expect(host.live.has(SESSION_KEY)).toBe(true);
  });

  it('given a session with no sandbox, should end it without touching the host', async () => {
    const store = makeAgentSessionStore([makeSessionRecord()]);
    const host = makeSpriteHost();
    const result = await endAgentSession({ workspaceId: SESSION_ID, deps: makeEndDeps(store, host) });

    expect(result).toEqual({ ok: true, spriteTornDown: false });
    expect(host.calls.kill).toHaveLength(0);
    expect(store.rows.get(SESSION_ID)!.endedAt).toEqual(NOW);
  });

  it('given an already-ended session, should be idempotent', async () => {
    const ended = makeSessionRecord({ endedAt: NOW, spriteTornDownAt: NOW });
    const store = makeAgentSessionStore([ended]);
    const host = makeSpriteHost();
    const result = await endAgentSession({ workspaceId: SESSION_ID, deps: makeEndDeps(store, host) });

    expect(result).toEqual({ ok: true, spriteTornDown: false });
    expect(host.calls.kill).toHaveLength(0);
  });

  it('given no such session, should report not_found', async () => {
    const store = makeAgentSessionStore();
    const result = await endAgentSession({ workspaceId: 'nope', deps: makeEndDeps(store, makeSpriteHost()) });

    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('should NOT gate teardown on authorization — releasing compute is always allowed', async () => {
    // There is no authorize seam on this path at all, by construction: an actor
    // who lost the right to a session must still be able to end it, and so must
    // every automated cleanup path.
    const store = makeAgentSessionStore([provisioned]);
    const host = makeSpriteHost({ seed: { [SESSION_KEY]: { instanceId: 'inst-live' } } });
    const deps = makeEndDeps(store, host);
    expect(Object.keys(deps)).toEqual(['store', 'host', 'now']);
    expect((await endAgentSession({ workspaceId: SESSION_ID, deps })).ok).toBe(true);
  });

  it('given a concurrent ensure that revived the session, should not stamp the LIVE replacement as dead', async () => {
    // The revive rewrote the row onto a new instance between our kill and our
    // stamp. Marking that as torn down would hide a billing Sprite from the
    // reconciler forever, so the instance CAS refuses.
    const store = makeAgentSessionStore([provisioned]);
    const host = makeSpriteHost({ seed: { [SESSION_KEY]: { instanceId: 'inst-live' } } });
    const deps = {
      store: {
        ...store.store,
        async findById(workspaceId: string) {
          const row = await store.store.findById(workspaceId);
          // The revive lands right after the plan is made.
          store.rows.set(SESSION_ID, makeSessionRecord({ ...provisioned, spriteInstanceId: 'inst-revived' }));
          return row;
        },
      },
      host: host.host,
      now: () => NOW,
    };
    const result = await endAgentSession({ workspaceId: SESSION_ID, deps });

    // Honest reporting (review #2261/3): the CAS refused, so the caller must
    // not be told the session ended — it is live again, on a Sprite this call
    // never touched.
    expect(result).toEqual({ ok: true, spriteTornDown: false });
    const row = store.rows.get(SESSION_ID)!;
    expect(row.spriteInstanceId).toBe('inst-revived');
    expect(row.spriteTornDownAt).toBeNull();
    expect(row.teardownRequestedAt).toBeNull();
  });

  it('given a concurrent ensure that PROVISIONS between the read and the stamp, should never strand endedAt on the newly-live row', async () => {
    // The acceptance test (review #2261): concurrent end + ensure must never
    // produce a row with endedAt set AND a live sandboxId AND no
    // teardownRequestedAt. Our plan reads sandboxId: null and computes a
    // never-provisioned noop; a concurrent ensure provisions in between. The
    // CAS on that stamp must refuse, and the retry must re-plan against what
    // the row actually is now — a real teardown, not a stale stamp.
    const neverProvisioned = makeSessionRecord();
    const store = makeAgentSessionStore([neverProvisioned]);
    const host = makeSpriteHost({ seed: { [SESSION_KEY]: { instanceId: 'inst-concurrent' } } });
    let reads = 0;
    const deps = {
      store: {
        ...store.store,
        async findById(workspaceId: string) {
          reads += 1;
          const row = await store.store.findById(workspaceId);
          if (reads === 1) {
            // The concurrent ensure wins the race right after our read.
            store.rows.set(
              SESSION_ID,
              makeSessionRecord({
                spriteKey: SESSION_KEY,
                sandboxId: SESSION_KEY,
                spriteInstanceId: 'inst-concurrent',
              }),
            );
          }
          return row;
        },
      },
      host: host.host,
      now: () => NOW,
    };

    const result = await endAgentSession({ workspaceId: SESSION_ID, deps });

    expect(reads).toBe(2);
    expect(result).toEqual({ ok: true, spriteTornDown: true });
    const row = store.rows.get(SESSION_ID)!;
    const isTheBadState = row.endedAt !== null && row.sandboxId !== null && row.teardownRequestedAt === null;
    expect(isTheBadState).toBe(false);
    // It retried and genuinely tore down the newly-provisioned session.
    expect(row.spriteTornDownAt).toEqual(NOW);
    expect(row.endedAt).toEqual(NOW);
    expect(host.calls.kill).toEqual([{ sandboxId: SESSION_KEY, expectedInstanceId: 'inst-concurrent' }]);
  });

  it('given a NORMALLY-ended session (provisioned, then ended — the common shape), should be idempotent without re-tearing-down', async () => {
    // review #2261/4: `row.sandboxId !== null` used to be checked BEFORE
    // `isEnded(row)`, and teardown never clears `sandboxId` — so this common
    // shape (not the never-provisioned one the old test covered) fell through
    // to the teardown branch on every re-end.
    const endedProvisioned = makeSessionRecord({
      spriteKey: SESSION_KEY,
      sandboxId: SESSION_KEY,
      spriteInstanceId: 'inst-live',
      teardownRequestedAt: NOW,
      spriteTornDownAt: NOW,
      endedAt: NOW,
    });
    const store = makeAgentSessionStore([endedProvisioned]);
    const host = makeSpriteHost();
    const result = await endAgentSession({ workspaceId: SESSION_ID, deps: makeEndDeps(store, host) });

    expect(result).toEqual({ ok: true, spriteTornDown: false });
    expect(host.calls.kill).toHaveLength(0);
  });
});

describe('end then ensure — the same session key comes back', () => {
  it('given a session ended and later ensured, should re-provision under the SAME spriteKey', async () => {
    const store = makeAgentSessionStore([
      makeSessionRecord({ spriteKey: SESSION_KEY, sandboxId: SESSION_KEY, spriteInstanceId: 'inst-first' }),
    ]);
    const host = makeSpriteHost({ seed: { [SESSION_KEY]: { instanceId: 'inst-first' } } });

    await endAgentSession({ workspaceId: SESSION_ID, deps: { store: store.store, host: host.host, now: () => NOW } });
    expect(store.rows.get(SESSION_ID)!.spriteTornDownAt).toEqual(NOW);
    expect(host.live.has(SESSION_KEY)).toBe(false);

    const row: AgentSessionSpriteRow = { ...store.rows.get(SESSION_ID)!, workspaceId: SESSION_ID };
    const provisioned = await ensureAgentSessionSandbox({
      row,
      intent: 'ensure',
      actor: { userId: OWNER_ID, tenantId: TENANT_ID },
      deps: {
        store: store.store,
        host: host.host,
        substrate: { kind: 'sprite' },
        options: {},
        secret: SECRET,
        authorize: async () => ({ ok: true }),
        checkFullEgressEnablement: async () => ({ ok: true }),
        checkConcurrency: async () => ({ allowed: true }),
        now: () => NOW,
      },
    });

    expect(provisioned).toEqual({ ok: true, sandboxId: SESSION_KEY, resumed: false });
    // Same name — same identity, fresh filesystem — and a live VM again.
    expect(host.calls.provision.map((call) => call.name)).toEqual([SESSION_KEY]);
    const revived = store.rows.get(SESSION_ID)!;
    expect(revived.spriteKey).toBe(SESSION_KEY);
    expect(revived.spriteTornDownAt).toBeNull();
    expect(revived.endedAt).toBeNull();
    expect(revived.spriteInstanceId).toBe(`inst-${SESSION_KEY}`);
  });
});

describe('toAgentSessionDTO', () => {
  it('should address the session by its OWN id and carry its drive', () => {
    const dto = toAgentSessionDTO(makeSessionRecord());
    expect(dto.workspaceId).toBe(SESSION_ID);
    expect(Object.keys(dto)).not.toContain('conversationId');
  });

  it('should emit ISO timestamps, never Date objects', () => {
    const dto = toAgentSessionDTO(makeSessionRecord({ lastActiveAt: NOW, endedAt: NOW }));
    expect(dto.createdAt).toBe(NOW.toISOString());
    expect(dto.lastActiveAt).toBe(NOW.toISOString());
    expect(dto.endedAt).toBe(NOW.toISOString());
  });

  it('should satisfy the shared contract schema', () => {
    expect(() => agentSessionDtoSchema.parse(toAgentSessionDTO(makeSessionRecord()))).not.toThrow();
    expect(() =>
      agentSessionDtoSchema.parse(
        toAgentSessionDTO(makeSessionRecord({ driveId: null, name: 'labelled', sandboxId: SESSION_KEY })),
      ),
    ).not.toThrow();
  });

  it('given an unlabelled session, should report an empty label rather than null', () => {
    expect(toAgentSessionDTO(makeSessionRecord({ name: null })).name).toBe('');
  });

  it('should derive the sandbox status from the row', () => {
    expect(toAgentSessionDTO(makeSessionRecord()).sandboxStatus).toBe('none');
    expect(toAgentSessionDTO(makeSessionRecord({ sandboxId: SESSION_KEY })).sandboxStatus).toBe('running');
    expect(
      toAgentSessionDTO(makeSessionRecord({ sandboxId: SESSION_KEY, spriteTornDownAt: NOW })).sandboxStatus,
    ).toBe('ended');
  });
});

describe('listAgentSessions', () => {
  const rows = [
    makeSessionRecord({ id: 'ses-a', sandboxId: SESSION_KEY }),
    makeSessionRecord({ id: 'ses-b', driveId: 'drive-other' }),
    makeSessionRecord({ id: 'ses-c', ownerId: 'user-2' }),
  ];

  it('given a drive filter, should return only that drive\'s sessions, as DTOs', async () => {
    const store = makeAgentSessionStore(rows);
    const sessions = await listAgentSessions({
      filter: { driveId: DRIVE_ID },
      deps: { store: store.store },
    });

    expect(sessions.map((session) => session.workspaceId).sort()).toEqual(['ses-a', 'ses-c']);
    expect(sessions.every((session) => agentSessionDtoSchema.safeParse(session).success)).toBe(true);
  });

  it('given an owner filter, should return only that owner\'s sessions', async () => {
    const store = makeAgentSessionStore(rows);
    const sessions = await listAgentSessions({ filter: { ownerId: 'user-2' }, deps: { store: store.store } });
    expect(sessions.map((session) => session.workspaceId)).toEqual(['ses-c']);
  });

  it('should report each session\'s sandbox status', async () => {
    const store = makeAgentSessionStore(rows);
    const sessions = await listAgentSessions({
      filter: { driveId: DRIVE_ID },
      deps: { store: store.store },
    });
    const byId = new Map(sessions.map((session) => [session.workspaceId, session.sandboxStatus]));
    expect(byId.get('ses-a')).toBe('running');
    expect(byId.get('ses-c')).toBe('none');
  });

  it('given no sessions, should return an empty list rather than fail', async () => {
    const store = makeAgentSessionStore();
    expect(await listAgentSessions({ filter: { ownerId: OWNER_ID }, deps: { store: store.store } })).toEqual([]);
  });

  describe('drive filter + global-assistant sessions (review: Codex P1 on #2325)', () => {
    const withGlobal = [
      makeSessionRecord({ id: 'ses-drive', sandboxId: SESSION_KEY }),
      makeSessionRecord({ id: 'ses-owner-global', driveId: null }),
      makeSessionRecord({ id: 'ses-other-owner-global', driveId: null, ownerId: 'user-2' }),
    ];

    it('given driveId + ownerId, should also include that owner\'s global sessions, not other owners\'', async () => {
      const store = makeAgentSessionStore(withGlobal);
      const sessions = await listAgentSessions({
        filter: { driveId: DRIVE_ID, ownerId: OWNER_ID },
        deps: { store: store.store },
      });
      expect(sessions.map((session) => session.workspaceId).sort()).toEqual(['ses-drive', 'ses-owner-global']);
    });

    it('given driveId with NO owner, should exclude every global session — no owner to scope the union to', async () => {
      const store = makeAgentSessionStore(withGlobal);
      const sessions = await listAgentSessions({
        filter: { driveId: DRIVE_ID },
        deps: { store: store.store },
      });
      expect(sessions.map((session) => session.workspaceId)).toEqual(['ses-drive']);
    });

    it('given driveId with an explicitly-undefined ownerId, should behave as ownerless — presence of the key is not enough (review: CodeRabbit)', async () => {
      // `AgentSessionListFilter` no longer HAS a variant shaped like this
      // (`ownerId` is either a real string or the key is absent entirely) —
      // the cast exists to pin the runtime guard against a value that
      // reaches here some other way (a bypassed cast, a loosely-typed
      // caller upstream), not to describe a shape callers should construct.
      const store = makeAgentSessionStore(withGlobal);
      const filter = { driveId: DRIVE_ID, ownerId: undefined } as unknown as AgentSessionListFilter;
      const sessions = await listAgentSessions({ filter, deps: { store: store.store } });
      expect(sessions.map((session) => session.workspaceId)).toEqual(['ses-drive']);
    });
  });
});
