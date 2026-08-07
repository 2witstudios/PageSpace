/**
 * CONVERGENCE PROPERTY — the layout verb queue (Agent-Session Single Source of
 * Truth epic, Phase 3; plan §D5).
 *
 * The optimistic queue makes exactly one promise:
 *
 *     rendered = replayPending(serverSnapshot, unackedVerbs)
 *
 * and therefore, once the queue drains, `rendered` IS the server's grid. The
 * example-based suites next door pin each transition of that machine. This one
 * attacks the promise: it generates random verb sequences, interleaves them with
 * CONCURRENT server-side writes (another device, or an AI tool posting
 * `open_conversation` straight into the same workspace) so `baseRev` goes stale
 * at arbitrary points, loses arbitrary responses so ops get re-posted under the
 * same `opId`, and then asserts that when the dust settles the client's grid and
 * the server's grid are structurally identical.
 *
 * **Two layers, because the queue has two.**
 *  1. A PURE model: the shared verb engine (`@pagespace/lib`) as the server, and
 *     `verb-queue.ts`'s `replayPending`/`adoptServerGrid`/`verbAlreadyLanded` as
 *     the client. No zustand, no fetch, no timers. The server model is a
 *     transcription of `lib/agent-sessions/workspace-layout-runtime.ts` —
 *     replay-check first, then `baseRev`, then reduce, then the content diff
 *     that decides whether rev moves.
 *  2. The REAL store, driven through its public actions with `fetchWithAuth`
 *     mocked to that same simulated server. React is never involved (zustand's
 *     vanilla store is just a function), but `settle()` — where the 200/409/
 *     rebase logic actually lives — is. A property that only exercised layer 1
 *     would prove the algebra and miss the wiring.
 *
 * **Reproducibility.** No fast-check in this repo; the house precedent is a
 * seeded LCG (`packages/lib/src/agent-sessions/__tests__/workspace-layout-verbs.test.ts`'s
 * blob≡rows drift guard, 25 seeds × 40 verbs). Same generator, same discipline:
 * every run is a pure function of one integer seed, every assertion names its
 * seed and step, and the generator's aggression scales with the seed so a
 * low-seed failure is already a small counterexample.
 *
 * **Structural comparison only.** `activePaneId`/`pendingPickerPaneId` are
 * deliberately client-local (the #2048 focus decision) and no row owns them, so
 * convergence is asserted through `gridFromWorkspaceState` — column order, pane
 * order, `kind`, `targetId`. That is precisely what the server is authoritative
 * for and precisely what the wire carries.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PaneScope, PersistedColumnState } from '@pagespace/lib/agent-sessions/contract';
import {
  applyVerbLocal,
  gridFromWorkspaceState,
  panesOf,
  workspaceLayoutVerbSchema,
  type WorkspaceLayoutVerb,
  type WorkspaceState,
} from '@pagespace/lib/agent-sessions/workspace-layout-verbs';
import { adoptServerGrid, replayPending, type PendingVerbOp } from '../verb-queue';
import { useAgentWorkspaceStore, __resetWorkspaceQueuesForTests } from '../useAgentWorkspaceStore';

const WORKSPACE_ID = 'ses-property';

const mockFetchWithAuth = vi.fn();
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

/** Deterministic LCG — the drift guard's generator, for the same reason. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// ---------------------------------------------------------------------------
// The simulated server — `workspace-layout-runtime.ts`, decision for decision.
// ---------------------------------------------------------------------------

type VerbResult =
  | { status: 'ok'; rev: number; grid: PersistedColumnState[]; applied: boolean }
  | { status: 'stale'; rev: number; grid: PersistedColumnState[] };

const gridDTO = (state: WorkspaceState | null): PersistedColumnState[] => state?.columns ?? [];

class SimulatedLayoutServer {
  state: WorkspaceState | null = null;
  rev = 0;
  /** `(workspaceId, opId)` op memory — what makes a re-posted verb a no-op. */
  private readonly ops = new Set<string>();
  /** Every op the server has ACTUALLY reduced, for the idempotency assertion. */
  readonly landed: string[] = [];

  apply(input: { opId: string; baseRev: number; verb: WorkspaceLayoutVerb }): VerbResult {
    const { opId, baseRev, verb } = input;

    // Replay check FIRST: an op that already landed must answer success with
    // current truth, never 409 — the retry's whole point is that its effect is
    // already part of the rev the client will observe.
    if (this.ops.has(opId)) {
      return { status: 'ok', rev: this.rev, grid: gridDTO(this.state), applied: false };
    }
    if (baseRev !== this.rev) {
      return { status: 'stale', rev: this.rev, grid: gridDTO(this.state) };
    }

    const outcome = applyVerbLocal(this.state, WORKSPACE_ID, verb);
    if (!outcome.applied || outcome.state === null) {
      this.ops.add(opId);
      return { status: 'ok', rev: this.rev, grid: gridDTO(this.state), applied: false };
    }

    // `replaceWorkspaceGrid`'s CONTENT diff — not the reducer's structural
    // verdict — is what decides whether rev moves and whether a broadcast fires.
    const changed = this.commit(outcome.state);
    this.ops.add(opId);
    if (changed) this.landed.push(opId);
    return { status: 'ok', rev: this.rev, grid: gridDTO(this.state), applied: changed };
  }

  /** A write from ANOTHER writer (a second device, an AI tool's placement verb). */
  concurrentWrite(verb: WorkspaceLayoutVerb): boolean {
    const outcome = applyVerbLocal(this.state, WORKSPACE_ID, verb);
    if (!outcome.applied || outcome.state === null) return false;
    return this.commit(outcome.state);
  }

  /** Persist `next`, bumping rev iff the rows actually changed. */
  private commit(next: WorkspaceState): boolean {
    const before = this.state === null ? null : JSON.stringify(gridFromWorkspaceState(this.state));
    const after = JSON.stringify(gridFromWorkspaceState(next));
    this.state = next;
    if (before === after) return false;
    this.rev += 1;
    return true;
  }

  snapshot(): { rev: number; grid: PersistedColumnState[] } {
    return { rev: this.rev, grid: gridDTO(this.state) };
  }
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const scopeFor = (rand: () => number): PaneScope => {
  const roll = rand();
  if (roll < 0.6) return { kind: 'chat', name: `Chat`, targetId: `conv-${Math.floor(rand() * 4)}`, agentPageId: 'agent-1' };
  if (roll < 0.8) return { kind: 'page', name: 'Page', targetId: `page-${Math.floor(rand() * 3)}`, agentPageId: null };
  if (roll < 0.9) return { kind: 'terminal', name: 'Shell', targetId: `shell-${Math.floor(rand() * 2)}`, agentPageId: null };
  // An in-flight mint: bound but not yet addressable. Never replaceable.
  return { kind: 'chat', name: '', targetId: null, agentPageId: null };
};

/**
 * A random verb against the state the caller believes it holds. Mixes
 * resolvable and unresolvable pane ids so the reducer's no-op paths (a stale
 * click racing a close) are generated too, not just the happy ones.
 */
function randomVerb(rand: () => number, state: WorkspaceState | null, mint: () => string): WorkspaceLayoutVerb {
  const scope = scopeFor(rand);
  const panes = state ? panesOf(state) : [];
  const paneId = rand() < 0.85 && panes.length > 0 ? panes[Math.floor(rand() * panes.length)].id : `ghost-${mint()}`;

  switch (Math.floor(rand() * 8)) {
    case 0:
      return { type: 'ensure', columnId: mint(), paneId: mint(), scope };
    case 1:
      return { type: 'split_right', fromPaneId: paneId, newColumnId: mint(), newPaneId: mint() };
    case 2:
      return { type: 'split_down', fromPaneId: paneId, newPaneId: mint() };
    case 3:
      return { type: 'assign_pane', paneId, scope };
    case 4:
      return { type: 'close_pane', paneId };
    case 5:
      return { type: 'reset_pane', paneId };
    case 6:
      return { type: 'open_conversation', scope, newColumnId: mint(), newPaneId: mint(), preferSplit: rand() < 0.3 };
    default:
      return { type: 'replace_conversation', oldTargetId: scope.targetId ?? 'conv-0', scope: scopeFor(rand) };
  }
}

/** Structural equality of two grids — what rows own, and nothing else. */
const structure = (state: WorkspaceState | null): unknown =>
  state === null ? null : gridFromWorkspaceState(state);

// ---------------------------------------------------------------------------
// Layer 1 — the pure queue model
// ---------------------------------------------------------------------------

interface PureClient {
  base: WorkspaceState | null;
  rev: number;
  pending: PendingVerbOp[];
}

const rendered = (client: PureClient): WorkspaceState | null =>
  replayPending(client.base, WORKSPACE_ID, client.pending);

const SEEDS = Array.from({ length: 120 }, (_, i) => i + 1);

describe('layout verb queue convergence (property, pure)', () => {
  it('given any verb sequence against a server that 409s at arbitrary points, should converge on the server grid', () => {
    let sawStale = 0;
    let sawReplay = 0;

    for (const seed of SEEDS) {
      const rand = prng(seed * 7919 + 101);
      const server = new SimulatedLayoutServer();
      const client: PureClient = { base: null, rev: 0, pending: [] };
      let minted = 0;
      const mint = () => `id-${seed}-${(minted += 1)}`;
      const steps = 6 + Math.floor(rand() * 24);
      const trace: string[] = [];

      /** Send the head op. `baseRev` is re-stamped from the CURRENT rev, as the store does. */
      const pump = (loseResponse: boolean) => {
        const op = client.pending[0];
        if (!op) return;
        const result = server.apply({ opId: op.opId, baseRev: client.rev, verb: op.verb });
        trace.push(`POST ${op.opId} (${op.verb.type}) base=${client.rev} -> ${result.status} rev=${result.rev}${loseResponse ? ' [RESPONSE LOST]' : ''}`);
        if (loseResponse) {
          // Transport failure after the server committed: the op stays ours to
          // retry, and its retry must find the op memory. This is the exact
          // "duplicate delivery" case `opId` exists for.
          sawReplay += 1;
          return;
        }
        if (result.status === 'stale') {
          sawStale += 1;
          // The 409 body IS the truth: rebase and keep the op queued.
          client.base = adoptServerGrid(WORKSPACE_ID, result.grid);
          client.rev = result.rev;
          return;
        }
        client.base = adoptServerGrid(WORKSPACE_ID, result.grid);
        client.rev = result.rev;
        client.pending = client.pending.filter((queued) => queued.opId !== op.opId);
      };

      for (let step = 0; step < steps; step += 1) {
        const roll = rand();
        if (roll < 0.45) {
          // A local mutation: reduce against what we RENDER, queue iff it applied.
          const verb = randomVerb(rand, rendered(client), mint);
          expect(workspaceLayoutVerbSchema.safeParse(verb).success, `seed ${seed} step ${step}`).toBe(true);
          if (applyVerbLocal(rendered(client), WORKSPACE_ID, verb).applied) {
            client.pending = [...client.pending, { opId: `op-${seed}-${step}`, baseRev: client.rev, verb }];
          }
        } else if (roll < 0.8) {
          pump(rand() < 0.2);
        } else {
          // Somebody else wrote. Every queued op's baseRev just went stale.
          server.concurrentWrite(randomVerb(rand, server.state, mint));
        }

        // THE equation, at every single step — not merely at the end.
        expect(rendered(client), `seed ${seed} step ${step}: rendered != replay(base, pending)`).toEqual(
          replayPending(client.base, WORKSPACE_ID, client.pending),
        );
      }

      // RECONCILE, then drain. New truth arrives (a mount GET, or the
      // `workspace:updated` broadcast the concurrent writers emitted) while the
      // queue is still loaded — so what is asserted below is precisely the
      // deliverable: unacked verbs replayed onto the returned truth converge.
      const truth = server.snapshot();
      if (truth.rev > client.rev) {
        trace.push(`ADOPT snapshot rev=${truth.rev} with ${client.pending.length} unacked`);
        client.base = adoptServerGrid(WORKSPACE_ID, truth.grid);
        client.rev = truth.rev;
      }
      // No more concurrent writers, so each op 409s at most once.
      for (let guard = 0; client.pending.length > 0 && guard < 200; guard += 1) pump(false);

      const where = `seed ${seed}\n${trace.join('\n')}`;
      expect(client.pending, `${where}\nqueue failed to drain`).toHaveLength(0);
      expect(structure(rendered(client)), where).toEqual(structure(server.state));
      expect(client.rev, where).toBe(server.rev);
    }

    // The generator must actually be producing the hostility it claims to.
    expect(sawStale, '409s generated').toBeGreaterThan(0);
    expect(sawReplay, 'lost responses forcing an opId replay').toBeGreaterThan(0);
  });

  it('given a verb re-posted under the same opId, should be a no-op on the server', () => {
    // Idempotency stated directly: the op memory answers success with CURRENT
    // truth, never a second application and never a 409.
    for (const seed of SEEDS.slice(0, 40)) {
      const rand = prng(seed * 40503 + 7);
      const server = new SimulatedLayoutServer();
      let minted = 0;
      const mint = () => `id-${seed}-${(minted += 1)}`;

      for (let step = 0; step < 12; step += 1) {
        const verb = randomVerb(rand, server.state, mint);
        const opId = `op-${seed}-${step}`;
        // Always posted at the current rev, so it never 409s — this test is
        // about the op memory, not about staleness.
        expect(server.apply({ opId, baseRev: server.rev, verb }).status, `seed ${seed} step ${step}`).toBe('ok');
        const revAfterFirst = server.rev;
        const gridAfterFirst = JSON.stringify(server.snapshot().grid);

        // Re-post the SAME op — twice, and once more after an unrelated write.
        const where = `seed ${seed} step ${step} (${verb.type})`;
        for (const attempt of [1, 2]) {
          const again = server.apply({ opId, baseRev: server.rev, verb });
          expect(again.status, `${where} attempt ${attempt}`).toBe('ok');
          expect(server.rev, `${where} attempt ${attempt}: rev moved on a replay`).toBe(revAfterFirst);
          expect(JSON.stringify(server.snapshot().grid), `${where} attempt ${attempt}: grid moved on a replay`).toBe(
            gridAfterFirst,
          );
        }

        // A replay arriving with a STALE baseRev must still answer ok, not 409 —
        // otherwise a retry after somebody else's write would 409 forever on an
        // op that already landed.
        server.concurrentWrite({ type: 'ensure', columnId: mint(), paneId: mint(), scope: scopeFor(rand) });
        const late = server.apply({ opId, baseRev: revAfterFirst, verb });
        expect(late.status, `${where}: replay under a stale baseRev`).toBe('ok');
      }

      // Every op the server reduced, it reduced exactly once.
      expect(new Set(server.landed).size, `seed ${seed}`).toBe(server.landed.length);
    }
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — the REAL store against the same simulated server
// ---------------------------------------------------------------------------

/** A minimal `Response` stand-in — only the three members the store reads. */
function reply(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

/** Let the microtask queue drain so an in-flight POST settles. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('layout verb queue convergence (property, real store)', () => {
  beforeEach(() => {
    mockFetchWithAuth.mockReset();
    __resetWorkspaceQueuesForTests();
  });

  it('given random store actions and a concurrently-written server, should converge once the queue drains', async () => {
    // Fewer seeds than layer 1: each step awaits a real microtask turn. Still
    // hundreds of verbs, and still under a second.
    for (let seed = 1; seed <= 30; seed += 1) {
      __resetWorkspaceQueuesForTests();
      const rand = prng(seed * 104729 + 3);
      const server = new SimulatedLayoutServer();
      const trace: string[] = [];
      let minted = 0;
      const mint = () => `id-${seed}-${(minted += 1)}`;

      mockFetchWithAuth.mockImplementation(async (_url: string, init?: RequestInit) => {
        if (init?.method !== 'POST') return reply(200, server.snapshot());
        const body = JSON.parse(init.body as string) as { opId: string; baseRev: number; verb: WorkspaceLayoutVerb };
        const result = server.apply(body);
        trace.push(`POST ${body.opId} (${body.verb.type}) base=${body.baseRev} -> ${result.status} rev=${result.rev}`);
        return result.status === 'stale'
          ? reply(409, { rev: result.rev, grid: result.grid })
          : reply(200, { rev: result.rev, grid: result.grid, applied: result.applied });
      });

      const store = () => useAgentWorkspaceStore.getState();
      const grid = () => store().workspaces[WORKSPACE_ID] ?? null;

      for (let step = 0; step < 12; step += 1) {
        const roll = rand();
        if (roll < 0.65) {
          const current = grid();
          if (!current) {
            store().ensureWorkspace(WORKSPACE_ID, scopeFor(rand));
          } else {
            const panes = panesOf(current);
            const paneId = panes[Math.floor(rand() * panes.length)].id;
            const pick = Math.floor(rand() * 5);
            if (pick === 0) store().splitRight(WORKSPACE_ID, paneId);
            else if (pick === 1) store().splitDown(WORKSPACE_ID, paneId);
            else if (pick === 2) store().assignPane(WORKSPACE_ID, paneId, scopeFor(rand));
            else if (pick === 3) store().closePane(WORKSPACE_ID, paneId);
            else store().openConversation(WORKSPACE_ID, scopeFor(rand));
          }
        } else if (roll < 0.85) {
          // Somebody else's write — every queued op's baseRev is now stale, so
          // the next POST 409s and the store must rebase on the body.
          server.concurrentWrite(randomVerb(rand, server.state, mint));
          trace.push(`CONCURRENT WRITE -> rev ${server.rev}`);
        }
        await settled();
      }

      // Reconcile through the store's OWN truth-adoption path while the queue is
      // still loaded — the mount/reconnect GET, which is the backstop for every
      // `workspace:updated` broadcast the concurrent writers emitted and this
      // client never received.
      store().hydrateFromServer(WORKSPACE_ID, server.snapshot());

      // Drain. Bounded: the store gives up after MAX_TRANSPORT_ATTEMPTS and
      // re-reads the snapshot, which is also convergence.
      for (let guard = 0; guard < 60 && store().sync[WORKSPACE_ID]?.pending.length; guard += 1) await settled();
      await settled();

      const where = `seed ${seed}\n${trace.join('\n')}`;
      expect(store().sync[WORKSPACE_ID]?.pending ?? [], `${where}\nqueue failed to drain`).toHaveLength(0);
      expect(structure(grid()), where).toEqual(structure(server.state));
      expect(store().sync[WORKSPACE_ID]?.rev ?? 0, where).toBe(server.rev);
    }
  });

  it('given a live workspace:updated broadcast at any rev, should never regress and never double-apply', async () => {
    // The third source of truth (after the mount GET and a verb's own response):
    // somebody else's verb, broadcast to the `session:` room. It must be adopted
    // when newer, dropped when not, and ignored entirely when it is the echo of
    // an op we are still waiting on — otherwise the still-queued op replays onto
    // a grid that already contains it.
    for (let seed = 1; seed <= 40; seed += 1) {
      __resetWorkspaceQueuesForTests();
      const rand = prng(seed * 2654435761 + 11);
      const server = new SimulatedLayoutServer();
      let minted = 0;
      const mint = () => `id-${seed}-${(minted += 1)}`;
      mockFetchWithAuth.mockImplementation(() => new Promise<Response>(() => {}));

      const store = () => useAgentWorkspaceStore.getState();
      server.concurrentWrite({ type: 'ensure', columnId: mint(), paneId: mint(), scope: scopeFor(rand) });
      store().hydrateFromServer(WORKSPACE_ID, server.snapshot());

      let lastRev = store().sync[WORKSPACE_ID].rev;
      for (let step = 0; step < 15; step += 1) {
        if (rand() < 0.4) {
          const current = store().workspaces[WORKSPACE_ID];
          if (current) store().splitRight(WORKSPACE_ID, panesOf(current)[0].id);
        }
        // A broadcast that may be current, ahead, or arbitrarily behind.
        server.concurrentWrite(randomVerb(rand, server.state, mint));
        const staleRev = Math.max(0, server.rev - Math.floor(rand() * 4));
        store().applyRemoteUpdate({
          workspaceId: WORKSPACE_ID,
          rev: staleRev,
          opId: rand() < 0.2 ? (store().sync[WORKSPACE_ID].pending[0]?.opId ?? null) : 'someone-else',
          grid: server.snapshot().grid,
        });

        const rev = store().sync[WORKSPACE_ID].rev;
        expect(rev, `seed ${seed} step ${step}: rev regressed`).toBeGreaterThanOrEqual(lastRev);
        lastRev = rev;
        // The equation survives every adoption.
        const sync = store().sync[WORKSPACE_ID];
        expect(structure(store().workspaces[WORKSPACE_ID] ?? null), `seed ${seed} step ${step}`).toEqual(
          structure(replayPending(sync.base, WORKSPACE_ID, sync.pending)),
        );
      }
    }
  });
});
