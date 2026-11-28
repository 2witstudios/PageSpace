/**
 * The agent lifecycle sweep (ADR 0008 Decision 13, [D-30] = 30 days; Agent
 * Signup Phase 5 leaf 3). The store and the erasure are injected, so this pins
 * the ORCHESTRATION: prune both expiring tables, ask the frozen
 * `decideAgentLifecycle` about every candidate, re-ask it against a fresh read
 * immediately before erasing (an agent may sign in mid-sweep), and never let
 * one failed erasure stop the sweep.
 */
import { describe, expect, it, vi } from 'vitest';
import { AGENT_UNAUTHENTICATED_TTL_MS } from '../../auth/agent/lifecycle-decision';
import { AGENT_LIFECYCLE_BATCH_LIMIT, sweepAgentLifecycle, type AgentLifecycleStore } from '../agent-lifecycle';

const NOW = new Date('2026-11-27T00:00:00.000Z');
const OLD = new Date(NOW.getTime() - AGENT_UNAUTHENTICATED_TTL_MS);
const YOUNG = new Date(NOW.getTime() - AGENT_UNAUTHENTICATED_TTL_MS + 1);

const abandoned = (userId: string, createdAt = OLD) => ({ userId, ownerUserId: null, lastAuthAt: null, createdAt });

function fakeStore(overrides: Partial<AgentLifecycleStore> = {}): AgentLifecycleStore {
  return {
    pruneExpiredChallenges: vi.fn(async () => 3),
    pruneExpiredClaims: vi.fn(async () => 2),
    findCandidates: vi.fn(async () => []),
    getLifecycleRow: vi.fn(async (userId: string) => abandoned(userId)),
    ...overrides,
  };
}

describe('sweepAgentLifecycle', () => {
  it('prunes expired signup challenges and claims as of now', async () => {
    const store = fakeStore();
    const result = await sweepAgentLifecycle({ now: NOW, store, eraseAgent: vi.fn() });

    expect(store.pruneExpiredChallenges).toHaveBeenCalledWith(NOW);
    expect(store.pruneExpiredClaims).toHaveBeenCalledWith(NOW);
    expect(result).toMatchObject({ challengesPruned: 3, claimsPruned: 2, erased: 0, failed: 0 });
  });

  it('asks for at most one batch of candidates created at or before the 30-day cutoff', async () => {
    const store = fakeStore();
    await sweepAgentLifecycle({ now: NOW, store, eraseAgent: vi.fn() });

    expect(store.findCandidates).toHaveBeenCalledWith({ createdAtOrBefore: OLD, limit: AGENT_LIFECYCLE_BATCH_LIMIT });
  });

  it('erases exactly the rows decideAgentLifecycle says to delete — never a claimed, signed-in or young agent', async () => {
    const eraseAgent = vi.fn(async () => {});
    const store = fakeStore({
      findCandidates: vi.fn(async () => [
        abandoned('a_old'),
        { ...abandoned('a_claimed'), ownerUserId: 'human_1' },
        { ...abandoned('a_signed_in'), lastAuthAt: NOW },
        abandoned('a_young', YOUNG),
      ]),
    });

    const result = await sweepAgentLifecycle({ now: NOW, store, eraseAgent });

    expect(eraseAgent).toHaveBeenCalledTimes(1);
    expect(eraseAgent).toHaveBeenCalledWith('a_old');
    expect(result).toMatchObject({ candidates: 4, erased: 1, kept: 3 });
  });

  it('re-decides against a fresh read right before erasing, so an agent that just signed in is kept', async () => {
    const eraseAgent = vi.fn(async () => {});
    const store = fakeStore({
      findCandidates: vi.fn(async () => [abandoned('a_racing'), abandoned('a_gone')]),
      getLifecycleRow: vi.fn(async (userId: string) =>
        userId === 'a_racing' ? { ...abandoned(userId), lastAuthAt: NOW } : null,
      ),
    });

    const result = await sweepAgentLifecycle({ now: NOW, store, eraseAgent });

    expect(eraseAgent).not.toHaveBeenCalled();
    expect(result).toMatchObject({ erased: 0, kept: 2 });
  });

  it('records a failed erasure and carries on with the rest', async () => {
    const eraseAgent = vi.fn(async (userId: string) => {
      if (userId === 'a_1') throw new Error('processor unavailable');
    });
    const store = fakeStore({ findCandidates: vi.fn(async () => [abandoned('a_1'), abandoned('a_2')]) });

    const result = await sweepAgentLifecycle({ now: NOW, store, eraseAgent });

    expect(eraseAgent).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ erased: 1, failed: 1 });
    expect(result.failures).toEqual([{ userId: 'a_1', error: 'processor unavailable' }]);
  });

  it('still sweeps agents when a prune fails, and reports the prune failure', async () => {
    const eraseAgent = vi.fn(async () => {});
    const store = fakeStore({
      pruneExpiredChallenges: vi.fn(async () => {
        throw new Error('db down');
      }),
      findCandidates: vi.fn(async () => [abandoned('a_1')]),
    });

    const result = await sweepAgentLifecycle({ now: NOW, store, eraseAgent });

    expect(result.challengesPruned).toBeNull();
    expect(result.claimsPruned).toBe(2);
    expect(eraseAgent).toHaveBeenCalledWith('a_1');
    expect(result.failures).toContainEqual({ userId: null, error: 'prune challenges: db down' });
  });
});
