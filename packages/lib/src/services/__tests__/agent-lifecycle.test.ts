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
import {
  AGENT_LIFECYCLE_BATCH_LIMIT,
  AGENT_LIFECYCLE_MAX_ERASURES_PER_RUN,
  sweepAgentLifecycle,
  type AgentLifecycleCandidate,
  type AgentLifecycleStore,
} from '../agent-lifecycle';

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

  it('asks for a first batch of candidates created at or before the 30-day cutoff, from the start', async () => {
    const store = fakeStore();
    await sweepAgentLifecycle({ now: NOW, store, eraseAgent: vi.fn() });

    expect(store.findCandidates).toHaveBeenCalledWith({ createdAtOrBefore: OLD, limit: AGENT_LIFECYCLE_BATCH_LIMIT, after: null });
    expect(store.findCandidates).toHaveBeenCalledTimes(1);
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

  // Security review: one 50-row batch a day could not keep up with the signup
  // budget (100/hour), so a backlog only grew. The sweep now drains batch after
  // batch until the backlog, an erasure budget or a time budget runs out.
  describe('draining a backlog', () => {
    /** A store over `rows` that pages by (createdAt, userId) like the real query. */
    function pagedStore(rows: AgentLifecycleCandidate[]): AgentLifecycleStore {
      const sorted = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.userId.localeCompare(b.userId));
      return fakeStore({
        findCandidates: vi.fn(async ({ limit, after }) => {
          const start = after === null ? 0 : sorted.findIndex((row) => row.userId === after.userId) + 1;
          return sorted.slice(start, start + limit);
        }),
      });
    }
    const backlog = (n: number) => Array.from({ length: n }, (_, i) => abandoned(`a_${String(i).padStart(4, '0')}`, new Date(OLD.getTime() - i)));

    it('given more abandoned agents than one batch, should keep fetching batches after the last row until none are left', async () => {
      const eraseAgent = vi.fn(async () => {});
      const store = pagedStore(backlog(7));

      const result = await sweepAgentLifecycle({ now: NOW, store, eraseAgent, limit: 3 });

      expect(eraseAgent).toHaveBeenCalledTimes(7);
      expect(result).toMatchObject({ candidates: 7, erased: 7, batches: 3, stoppedBy: 'drained' });
      const calls = vi.mocked(store.findCandidates).mock.calls.map(([arg]) => arg.after);
      expect(calls[0]).toBeNull();
      expect(calls[1]).toEqual({ createdAt: expect.any(Date), userId: expect.any(String) });
    });

    it('given rows it keeps or fails on, should page PAST them instead of fetching the same batch forever', async () => {
      const rows = backlog(4).map((row, i) => (i % 2 === 0 ? { ...row, lastAuthAt: NOW } : row));
      const eraseAgent = vi.fn(async () => {});
      const store = pagedStore(rows);

      const result = await sweepAgentLifecycle({ now: NOW, store, eraseAgent, limit: 2 });

      expect(result).toMatchObject({ candidates: 4, erased: 2, kept: 2, stoppedBy: 'drained' });
      expect(vi.mocked(store.findCandidates).mock.calls.length).toBe(3);
    });

    it('should stop at the per-run erasure budget and leave the rest for the next hourly tick', async () => {
      const eraseAgent = vi.fn(async () => {});
      const result = await sweepAgentLifecycle({ now: NOW, store: pagedStore(backlog(10)), eraseAgent, limit: 3, maxErasures: 4 });

      expect(eraseAgent).toHaveBeenCalledTimes(4);
      expect(result).toMatchObject({ erased: 4, stoppedBy: 'erasure_budget' });
    });

    it('should stop when the time budget is spent', async () => {
      let elapsed = 0;
      const eraseAgent = vi.fn(async () => {
        elapsed += 1000;
      });
      const result = await sweepAgentLifecycle({
        now: NOW,
        store: pagedStore(backlog(10)),
        eraseAgent,
        limit: 3,
        timeBudgetMs: 2500,
        elapsedMs: () => elapsed,
      });

      expect(result.erased).toBe(3);
      expect(result.stoppedBy).toBe('time_budget');
    });

    it('should drain far more than one batch per run by default', () => {
      expect(AGENT_LIFECYCLE_MAX_ERASURES_PER_RUN).toBeGreaterThanOrEqual(10 * AGENT_LIFECYCLE_BATCH_LIMIT);
    });
  });
});
