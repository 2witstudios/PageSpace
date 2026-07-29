import { describe, it, expect } from 'vitest';
import {
  ensureAgentSession,
  endAgentSession,
  listAgentSessions,
  toAgentSessionDTO,
  type EnsureAgentSessionDeps,
} from '../agent-sessions';
import { ensureAgentSessionSandbox, type AgentSessionSpriteRow } from '../agent-session-sprite';
import { agentSessionDtoSchema } from '../../../agent-sessions/contract';
import { deriveAgentSessionSpriteKey } from '../../../agent-sessions/session-sprite-key';
import {
  AGENT_PAGE_ID,
  NOW,
  OWNER_ID,
  SECRET,
  SESSION_ID,
  TENANT_ID,
  makeAgentSessionStore,
  makeSessionRecord,
  makeSpriteHost,
} from './fakes';

const SESSION_KEY = deriveAgentSessionSpriteKey({ tenantId: TENANT_ID, sessionId: SESSION_ID, secret: SECRET });

function makeEnsureDeps(
  store: ReturnType<typeof makeAgentSessionStore>,
  over: Partial<EnsureAgentSessionDeps> = {},
): EnsureAgentSessionDeps {
  return {
    store: store.store,
    ensureConversation: async () => {},
    now: () => NOW,
    ...over,
  };
}

describe('ensureAgentSession', () => {
  it('given a conversation with no session, should create the row and return it', async () => {
    const store = makeAgentSessionStore();
    const result = await ensureAgentSession({
      userId: OWNER_ID,
      agentPageId: AGENT_PAGE_ID,
      conversationId: SESSION_ID,
      deps: makeEnsureDeps(store),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.session.conversationId).toBe(SESSION_ID);
    expect(result.session.ownerId).toBe(OWNER_ID);
    expect(result.session.agentPageId).toBe(AGENT_PAGE_ID);
    // Lazily acquired means exactly that: a row exists, a sandbox does not.
    expect(result.session.sandboxId).toBeNull();
  });

  it('should ensure the CONVERSATION row first — the session PK is a FK onto it', async () => {
    const order: string[] = [];
    const store = makeAgentSessionStore();
    const wrapped = {
      ...store,
      store: {
        ...store.store,
        insertIfAbsent: async (input: Parameters<typeof store.store.insertIfAbsent>[0]) => {
          order.push('session');
          return store.store.insertIfAbsent(input);
        },
      },
    };
    await ensureAgentSession({
      userId: OWNER_ID,
      agentPageId: AGENT_PAGE_ID,
      conversationId: SESSION_ID,
      deps: makeEnsureDeps(wrapped, {
        store: wrapped.store,
        ensureConversation: async () => {
          order.push('conversation');
        },
      }),
    });

    expect(order).toEqual(['conversation', 'session']);
  });

  it('should route conversation creation through the injected squat-guarded path, carrying the agent page', async () => {
    const store = makeAgentSessionStore();
    const seen: unknown[] = [];
    await ensureAgentSession({
      userId: OWNER_ID,
      agentPageId: AGENT_PAGE_ID,
      conversationId: SESSION_ID,
      deps: makeEnsureDeps(store, {
        ensureConversation: async (input) => {
          seen.push(input);
        },
      }),
    });

    expect(seen).toEqual([{ conversationId: SESSION_ID, userId: OWNER_ID, agentPageId: AGENT_PAGE_ID }]);
  });

  it('given CONCURRENT ensures for one conversation, should end up with exactly ONE row', async () => {
    // The PK is the conversation id, so the insert conflict IS the concurrency
    // control — neither caller errors and neither has to know it lost.
    const store = makeAgentSessionStore();
    const deps = makeEnsureDeps(store);
    const [first, second] = await Promise.all([
      ensureAgentSession({ userId: OWNER_ID, agentPageId: AGENT_PAGE_ID, conversationId: SESSION_ID, deps }),
      ensureAgentSession({ userId: OWNER_ID, agentPageId: AGENT_PAGE_ID, conversationId: SESSION_ID, deps }),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(store.rows.size).toBe(1);
    expect(store.calls.insertIfAbsent).toBe(2);
  });

  it('given an existing session, should return it unchanged rather than reset it', async () => {
    const existing = makeSessionRecord({ name: 'my shell work', sandboxId: SESSION_KEY, lastActiveAt: NOW });
    const store = makeAgentSessionStore([existing]);
    const result = await ensureAgentSession({
      userId: OWNER_ID,
      agentPageId: AGENT_PAGE_ID,
      conversationId: SESSION_ID,
      name: 'a different label',
      deps: makeEnsureDeps(store),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.session.name).toBe('my shell work');
    expect(result.session.sandboxId).toBe(SESSION_KEY);
  });

  it('given a global-assistant session, should create it with a null agent page', async () => {
    const store = makeAgentSessionStore();
    const result = await ensureAgentSession({
      userId: OWNER_ID,
      agentPageId: null,
      conversationId: SESSION_ID,
      deps: makeEnsureDeps(store),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.session.agentPageId).toBeNull();
  });

  it('given a conversation the squat guard refuses to claim, should report it unavailable', async () => {
    // The guard returns silently, so the FK insert is what fails — either way the
    // caller learns the same fact: this id cannot host a session.
    const store = makeAgentSessionStore();
    const result = await ensureAgentSession({
      userId: OWNER_ID,
      agentPageId: AGENT_PAGE_ID,
      conversationId: SESSION_ID,
      deps: makeEnsureDeps(store, {
        store: { ...store.store, insertIfAbsent: async () => { throw new Error('violates foreign key constraint'); } },
      }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('conversation_unavailable');
    expect(result.detail).toContain('foreign key');
  });

  it('given an insert that silently does not land, should report it unavailable rather than invent a row', async () => {
    const store = makeAgentSessionStore();
    const result = await ensureAgentSession({
      userId: OWNER_ID,
      agentPageId: AGENT_PAGE_ID,
      conversationId: SESSION_ID,
      deps: makeEnsureDeps(store, { store: { ...store.store, insertIfAbsent: async () => {} } }),
    });

    expect(result).toEqual({ ok: false, reason: 'conversation_unavailable' });
  });

  it('given the conversation ensure itself failing, should not create an orphan session row', async () => {
    const store = makeAgentSessionStore();
    const result = await ensureAgentSession({
      userId: OWNER_ID,
      agentPageId: AGENT_PAGE_ID,
      conversationId: SESSION_ID,
      deps: makeEnsureDeps(store, { ensureConversation: async () => { throw new Error('db down'); } }),
    });

    expect(result.ok).toBe(false);
    expect(store.rows.size).toBe(0);
  });
});

describe('endAgentSession', () => {
  const provisioned = makeSessionRecord({
    sessionKey: SESSION_KEY,
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
    const result = await endAgentSession({ sessionId: SESSION_ID, deps: makeEndDeps(store, host) });

    expect(result).toEqual({ ok: true, spriteTornDown: true });
    expect(host.calls.kill).toEqual([{ sandboxId: SESSION_KEY, expectedInstanceId: 'inst-live' }]);
    const row = store.rows.get(SESSION_ID)!;
    expect(row.spriteTornDownAt).toEqual(NOW);
    expect(row.endedAt).toEqual(NOW);
  });

  it('should KEEP the row — a killed session is re-provisionable, not deleted', async () => {
    const store = makeAgentSessionStore([provisioned]);
    const host = makeSpriteHost({ seed: { [SESSION_KEY]: { instanceId: 'inst-live' } } });
    await endAgentSession({ sessionId: SESSION_ID, deps: makeEndDeps(store, host) });

    expect(store.rows.has(SESSION_ID)).toBe(true);
    expect(store.rows.get(SESSION_ID)!.sessionKey).toBe(SESSION_KEY);
  });

  it('should record the teardown INTENT before the kill, so a crash in between stays reclaimable', async () => {
    const store = makeAgentSessionStore([provisioned]);
    const host = makeSpriteHost({
      seed: { [SESSION_KEY]: { instanceId: 'inst-live' } },
      killError: new Error('control plane down'),
    });
    const result = await endAgentSession({ sessionId: SESSION_ID, deps: makeEndDeps(store, host) });

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
    const result = await endAgentSession({ sessionId: SESSION_ID, deps: makeEndDeps(store, host) });

    expect(result).toEqual({ ok: true, spriteTornDown: true });
    // The replacement is NOT destroyed — the host refused, and we did not retry
    // without the guard.
    expect(host.live.has(SESSION_KEY)).toBe(true);
  });

  it('given a session with no sandbox, should end it without touching the host', async () => {
    const store = makeAgentSessionStore([makeSessionRecord()]);
    const host = makeSpriteHost();
    const result = await endAgentSession({ sessionId: SESSION_ID, deps: makeEndDeps(store, host) });

    expect(result).toEqual({ ok: true, spriteTornDown: false });
    expect(host.calls.kill).toHaveLength(0);
    expect(store.rows.get(SESSION_ID)!.endedAt).toEqual(NOW);
  });

  it('given an already-ended session, should be idempotent', async () => {
    const ended = makeSessionRecord({ endedAt: NOW, spriteTornDownAt: NOW });
    const store = makeAgentSessionStore([ended]);
    const host = makeSpriteHost();
    const result = await endAgentSession({ sessionId: SESSION_ID, deps: makeEndDeps(store, host) });

    expect(result).toEqual({ ok: true, spriteTornDown: false });
    expect(host.calls.kill).toHaveLength(0);
  });

  it('given no such session, should report not_found', async () => {
    const store = makeAgentSessionStore();
    const result = await endAgentSession({ sessionId: 'nope', deps: makeEndDeps(store, makeSpriteHost()) });

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
    expect((await endAgentSession({ sessionId: SESSION_ID, deps })).ok).toBe(true);
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
        async findById(sessionId: string) {
          const row = await store.store.findById(sessionId);
          // The revive lands right after the plan is made.
          store.rows.set(SESSION_ID, makeSessionRecord({ ...provisioned, spriteInstanceId: 'inst-revived' }));
          return row;
        },
      },
      host: host.host,
      now: () => NOW,
    };
    const result = await endAgentSession({ sessionId: SESSION_ID, deps });

    expect(result.ok).toBe(true);
    const row = store.rows.get(SESSION_ID)!;
    expect(row.spriteInstanceId).toBe('inst-revived');
    expect(row.spriteTornDownAt).toBeNull();
    expect(row.teardownRequestedAt).toBeNull();
  });
});

describe('end then ensure — the same session key comes back', () => {
  it('given a session ended and later ensured, should re-provision under the SAME sessionKey', async () => {
    const store = makeAgentSessionStore([
      makeSessionRecord({ sessionKey: SESSION_KEY, sandboxId: SESSION_KEY, spriteInstanceId: 'inst-first' }),
    ]);
    const host = makeSpriteHost({ seed: { [SESSION_KEY]: { instanceId: 'inst-first' } } });

    await endAgentSession({ sessionId: SESSION_ID, deps: { store: store.store, host: host.host, now: () => NOW } });
    expect(store.rows.get(SESSION_ID)!.spriteTornDownAt).toEqual(NOW);
    expect(host.live.has(SESSION_KEY)).toBe(false);

    const row: AgentSessionSpriteRow = { ...store.rows.get(SESSION_ID)!, sessionId: SESSION_ID };
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
        resolveDriveId: async () => 'drive-1',
        checkFullEgressEnablement: async () => ({ ok: true }),
        checkConcurrency: async () => ({ allowed: true }),
        now: () => NOW,
      },
    });

    expect(provisioned).toEqual({ ok: true, sandboxId: SESSION_KEY, resumed: false });
    // Same name — same identity, fresh filesystem — and a live VM again.
    expect(host.calls.provision.map((call) => call.name)).toEqual([SESSION_KEY]);
    const revived = store.rows.get(SESSION_ID)!;
    expect(revived.sessionKey).toBe(SESSION_KEY);
    expect(revived.spriteTornDownAt).toBeNull();
    expect(revived.endedAt).toBeNull();
    expect(revived.spriteInstanceId).toBe(`inst-${SESSION_KEY}`);
  });
});

describe('toAgentSessionDTO', () => {
  it('should address the session by its conversation id — there is no second id', () => {
    const dto = toAgentSessionDTO(makeSessionRecord());
    expect(dto.sessionId).toBe(SESSION_ID);
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
        toAgentSessionDTO(makeSessionRecord({ agentPageId: null, name: 'labelled', sandboxId: SESSION_KEY })),
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
    makeSessionRecord({ conversationId: 'conv-a', sandboxId: SESSION_KEY }),
    makeSessionRecord({ conversationId: 'conv-b', agentPageId: 'page-other' }),
    makeSessionRecord({ conversationId: 'conv-c', ownerId: 'user-2' }),
  ];

  it('given an agent page filter, should return only that agent\'s sessions, as DTOs', async () => {
    const store = makeAgentSessionStore(rows);
    const sessions = await listAgentSessions({
      filter: { agentPageId: AGENT_PAGE_ID },
      deps: { store: store.store },
    });

    expect(sessions.map((session) => session.sessionId).sort()).toEqual(['conv-a', 'conv-c']);
    expect(sessions.every((session) => agentSessionDtoSchema.safeParse(session).success)).toBe(true);
  });

  it('given an owner filter, should return only that owner\'s sessions', async () => {
    const store = makeAgentSessionStore(rows);
    const sessions = await listAgentSessions({ filter: { ownerId: 'user-2' }, deps: { store: store.store } });
    expect(sessions.map((session) => session.sessionId)).toEqual(['conv-c']);
  });

  it('should report each session\'s sandbox status', async () => {
    const store = makeAgentSessionStore(rows);
    const sessions = await listAgentSessions({
      filter: { agentPageId: AGENT_PAGE_ID },
      deps: { store: store.store },
    });
    const byId = new Map(sessions.map((session) => [session.sessionId, session.sandboxStatus]));
    expect(byId.get('conv-a')).toBe('running');
    expect(byId.get('conv-c')).toBe('none');
  });

  it('given no sessions, should return an empty list rather than fail', async () => {
    const store = makeAgentSessionStore();
    expect(await listAgentSessions({ filter: { ownerId: OWNER_ID }, deps: { store: store.store } })).toEqual([]);
  });
});
