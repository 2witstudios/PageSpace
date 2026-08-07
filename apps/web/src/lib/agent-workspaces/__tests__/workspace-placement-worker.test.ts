// @vitest-environment node
/**
 * SERVER-SIDE PANE PLACEMENT — the Phase 3 capability itself.
 *
 * In the blob era a server-side action could not put anything in front of a
 * user: the grid's only writer was the browser's debounced PUT, so a spawn
 * that nobody had the grid open for was simply never seen. `placeWorkerPane`
 * is the half of that capability that lives on the server — one
 * `open_conversation` verb against the relational rows, applied through the
 * SAME single writer a browser POST goes through.
 *
 * Three properties are load-bearing and none of them are obvious from the
 * call site:
 *
 * 1. **The verb it builds.** `preferSplit: true` (an agent ADDS a surface
 *    beside what the user is doing, it never navigates their panes) and the
 *    `excludeTargetId` pass-through (the conversation that spawned the worker
 *    must never be evicted by its own spawn).
 * 2. **The opId is CONSTANT across rebase attempts.** The caller derives it
 *    from the tool call id; a rebase is the SAME op. Minting a fresh one per
 *    attempt would defeat the verb engine's op memory and let an SDK retry —
 *    or a rebase whose earlier attempt actually landed — place a second pane.
 * 3. **It never throws.** The spawn has already succeeded by the time this
 *    runs; failing the turn over a courtesy pane would be strictly worse than
 *    the pane not appearing.
 *
 * The companion half (`useWorkspaceLayoutSync`) turns the resulting broadcast
 * into a live pane; a workspace nobody has open just has the pane waiting.
 * This file covers the server half, including placement into a workspace that
 * has never been hydrated at all (rev 0 / `grid: null`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkspaceLayoutVerb } from '@pagespace/lib/agent-workspaces/workspace-layout-verbs';

const { mockApplyVerb, mockReadSnapshot, mockWarn, mockError, mintedIds } = vi.hoisted(() => ({
  mockApplyVerb: vi.fn(),
  mockReadSnapshot: vi.fn(),
  mockWarn: vi.fn(),
  mockError: vi.fn(),
  mintedIds: { next: 0 },
}));

vi.mock('../workspace-layout-runtime', () => ({
  applyWorkspaceLayoutVerb: (...args: unknown[]) => mockApplyVerb(...args),
  readWorkspaceLayoutSnapshot: (...args: unknown[]) => mockReadSnapshot(...args),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { warn: mockWarn, error: mockError } },
}));
// The module imports the db at load even though neither entry point under
// test touches a row.
vi.mock('@pagespace/db/db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn() }));
vi.mock('@pagespace/db/schema/conversations', () => ({ conversations: {} }));
vi.mock('@pagespace/db/schema/core', () => ({ pages: {} }));
vi.mock('@pagespace/lib/permissions/permissions', () => ({ getUserAccessLevel: async () => 'VIEW' }));
vi.mock('@paralleldrive/cuid2', () => ({
  createId: () => {
    mintedIds.next += 1;
    return `minted-${mintedIds.next}`;
  },
}));

import { applyLayoutVerbForWorkspace, placeWorkerPane } from '../workspace-placement';

const WORKSPACE = 'ws-1';
const WORKER = 'conv-worker';
const CALLER = 'conv-caller';
const OP_ID = 'spawn_session:toolcall-abc';

/** What `placeWorkerPane` is called with on the real spawn path. */
function spawnPlacement(overrides: Partial<Parameters<typeof placeWorkerPane>[0]> = {}) {
  return placeWorkerPane({
    workspaceId: WORKSPACE,
    conversationId: WORKER,
    name: 'Research worker',
    agentPageId: 'agent-page-1',
    opId: OP_ID,
    excludeTargetId: CALLER,
    ...overrides,
  });
}

/** The single argument object `applyWorkspaceLayoutVerb` was called with, per attempt. */
type VerbCall = {
  workspaceId: string;
  opId: string;
  baseRev: number;
  viewerId: string | null;
  verb: { type: string; scope?: Record<string, unknown>; preferSplit?: boolean; excludeTargetId?: string };
};
function verbCalls(): VerbCall[] {
  return mockApplyVerb.mock.calls.map((call) => call[0] as VerbCall);
}

beforeEach(() => {
  vi.clearAllMocks();
  mintedIds.next = 0;
  mockReadSnapshot.mockResolvedValue({ rev: 7, grid: [{ id: 'col-1', panes: [] }] });
  mockApplyVerb.mockResolvedValue({ status: 'ok', rev: 8, grid: [], applied: true });
});

describe('placeWorkerPane — the verb it builds', () => {
  it('places the worker into an ALREADY-OPEN grid as an open_conversation chat pane', async () => {
    await spawnPlacement();

    expect(mockApplyVerb).toHaveBeenCalledTimes(1);
    const [call] = verbCalls();
    expect(call.workspaceId).toBe(WORKSPACE);
    expect(call.opId).toBe(OP_ID);
    // Rebased onto whatever the grid's rev actually is right now.
    expect(call.baseRev).toBe(7);
    // Nothing is returned to anyone, so there is no viewer to label for.
    expect(call.viewerId).toBeNull();
    expect(call.verb.type).toBe('open_conversation');
    expect(call.verb.scope).toEqual({
      kind: 'chat',
      name: 'Research worker',
      targetId: WORKER,
      agentPageId: 'agent-page-1',
    });
  });

  it('SPLITS rather than navigating a pane the user is already using', async () => {
    await spawnPlacement();
    expect(verbCalls()[0].verb.preferSplit).toBe(true);
  });

  it('never lets a spawning conversation be evicted by its own spawn', async () => {
    await spawnPlacement({ excludeTargetId: CALLER });
    // Without this pass-through, the caller's own pane is a fill candidate and
    // the user watches their chat get replaced by the worker they just asked for.
    expect(verbCalls()[0].verb.excludeTargetId).toBe(CALLER);
  });

  it('omits excludeTargetId entirely when the spawner is not in this grid', async () => {
    await spawnPlacement({ excludeTargetId: undefined });
    expect(verbCalls()[0].verb).not.toHaveProperty('excludeTargetId');
  });

  it('carries a null agentPageId through for a worker bound to no agent page', async () => {
    await spawnPlacement({ agentPageId: null });
    expect(verbCalls()[0].verb.scope).toMatchObject({ agentPageId: null });
  });

  it('mints FRESH column and pane ids for the new surface', async () => {
    await spawnPlacement();
    const verb = verbCalls()[0].verb as unknown as { newColumnId: string; newPaneId: string };
    expect(verb.newColumnId).toBe('minted-1');
    expect(verb.newPaneId).toBe('minted-2');
    expect(verb.newColumnId).not.toBe(verb.newPaneId);
  });
});

describe('placeWorkerPane — a workspace nobody has ever opened', () => {
  it('applies against an EMPTY, never-hydrated workspace (rev 0 / grid null)', async () => {
    // The whole point of Phase 3: no browser has this grid open, so there is
    // nothing to react to a streamed tool result. The pane is simply there
    // when the grid is opened an hour later.
    mockReadSnapshot.mockResolvedValue({ rev: 0, grid: null });

    await spawnPlacement();

    expect(mockApplyVerb).toHaveBeenCalledTimes(1);
    expect(verbCalls()[0].baseRev).toBe(0);
    expect(verbCalls()[0].verb.type).toBe('open_conversation');
  });
});

describe('placeWorkerPane — the rebase loop', () => {
  it('re-reads the snapshot and retries when the server answers stale', async () => {
    mockReadSnapshot
      .mockResolvedValueOnce({ rev: 7, grid: [] })
      .mockResolvedValueOnce({ rev: 9, grid: [] })
      .mockResolvedValue({ rev: 11, grid: [] });
    mockApplyVerb
      .mockResolvedValueOnce({ status: 'stale', rev: 9, grid: [] })
      .mockResolvedValueOnce({ status: 'stale', rev: 11, grid: [] })
      .mockResolvedValue({ status: 'ok', rev: 12, grid: [], applied: true });

    await spawnPlacement();

    expect(mockReadSnapshot).toHaveBeenCalledTimes(3);
    // Each attempt rebases onto the rev it just re-read, not the one it started with.
    expect(verbCalls().map((call) => call.baseRev)).toEqual([7, 9, 11]);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('reuses ONE opId across every rebase attempt (op memory, not a second pane)', async () => {
    mockApplyVerb
      .mockResolvedValueOnce({ status: 'stale', rev: 8, grid: [] })
      .mockResolvedValueOnce({ status: 'stale', rev: 9, grid: [] })
      .mockResolvedValue({ status: 'ok', rev: 10, grid: [], applied: true });

    await spawnPlacement();

    const opIds = verbCalls().map((call) => call.opId);
    expect(opIds).toHaveLength(3);
    // Constancy is the WHOLE mechanism: a rebase (or an SDK retry of the same
    // tool call) replays through op memory instead of double-placing.
    expect(new Set(opIds)).toEqual(new Set([OP_ID]));
  });

  it('gives up QUIETLY after 3 attempts on a permanently contended workspace', async () => {
    mockApplyVerb.mockResolvedValue({ status: 'stale', rev: 99, grid: [] });

    // No throw: the spawn already succeeded.
    await expect(spawnPlacement()).resolves.toBeUndefined();

    expect(mockApplyVerb).toHaveBeenCalledTimes(3);
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('gave up'),
      expect.objectContaining({ workspaceId: WORKSPACE }),
    );
    expect(mockError).not.toHaveBeenCalled();
  });
});

describe('placeWorkerPane — never throws', () => {
  it('swallows and logs a failing snapshot read', async () => {
    mockReadSnapshot.mockRejectedValue(new Error('db down'));

    await expect(spawnPlacement()).resolves.toBeUndefined();

    expect(mockApplyVerb).not.toHaveBeenCalled();
    expect(mockError).toHaveBeenCalledWith(
      expect.stringContaining('Could not place a pane for a spawned worker'),
      expect.any(Error),
      expect.objectContaining({ workspaceId: WORKSPACE, conversationId: WORKER }),
    );
  });

  it('swallows and logs a failing verb application', async () => {
    mockApplyVerb.mockRejectedValue(new Error('lock timeout'));

    await expect(spawnPlacement()).resolves.toBeUndefined();

    expect(mockError).toHaveBeenCalledTimes(1);
  });

  it('swallows a non-Error rejection without logging a bogus Error', async () => {
    mockApplyVerb.mockRejectedValue('a string, somehow');

    await expect(spawnPlacement()).resolves.toBeUndefined();

    expect(mockError).toHaveBeenCalledWith(
      expect.any(String),
      undefined,
      expect.objectContaining({ workspaceId: WORKSPACE }),
    );
  });
});

/**
 * The rearrange tools' path in (issue #2208). Same loop, same constant opId,
 * same single writer — but unlike a placement it REPORTS its outcome, because
 * the model asked for this explicitly and must be told the truth.
 */
describe('applyLayoutVerbForWorkspace', () => {
  const VERB: WorkspaceLayoutVerb = { type: 'close_pane', paneId: 'pane-1' };

  it('reports the applied verdict from the engine', async () => {
    mockApplyVerb.mockResolvedValue({ status: 'ok', rev: 8, grid: [], applied: true });
    await expect(
      applyLayoutVerbForWorkspace({ workspaceId: WORKSPACE, opId: 'op-x', verb: VERB }),
    ).resolves.toEqual({ ok: true, applied: true });
  });

  it('reports applied:false for a no-op (an op memory replay included)', async () => {
    mockApplyVerb.mockResolvedValue({ status: 'ok', rev: 8, grid: [], applied: false });
    await expect(
      applyLayoutVerbForWorkspace({ workspaceId: WORKSPACE, opId: 'op-x', verb: VERB }),
    ).resolves.toEqual({ ok: true, applied: false });
  });

  it('rebases under one constant opId and reports `contended` after 3 attempts', async () => {
    mockApplyVerb.mockResolvedValue({ status: 'stale', rev: 99, grid: [] });

    await expect(
      applyLayoutVerbForWorkspace({ workspaceId: WORKSPACE, opId: 'op-x', verb: VERB }),
    ).resolves.toEqual({ ok: false, reason: 'contended' });

    expect(mockApplyVerb).toHaveBeenCalledTimes(3);
    expect(new Set(verbCalls().map((call) => call.opId))).toEqual(new Set(['op-x']));
    expect(mockWarn).toHaveBeenCalled();
  });

  it('reports `failed` instead of throwing when the engine throws', async () => {
    mockApplyVerb.mockRejectedValue(new Error('boom'));

    await expect(
      applyLayoutVerbForWorkspace({ workspaceId: WORKSPACE, opId: 'op-x', verb: VERB }),
    ).resolves.toEqual({ ok: false, reason: 'failed' });

    expect(mockError).toHaveBeenCalled();
  });
});
