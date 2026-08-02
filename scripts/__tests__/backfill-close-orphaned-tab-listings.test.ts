/**
 * Tests for the orphaned-tab-listing backfill (review finding — chatgpt-
 * codex-connector on PR #2308). `findOrphanedBackgroundTabIds` is the pure
 * planner (unit-tested directly, no database); `runBackfill` is the
 * imperative loop, exercised here with a stubbed `getMigrationDb`.
 */
import { describe, it, expect, vi } from 'vitest';

const mockSelect = vi.fn();
const mockUpdate = vi.fn();

vi.mock('@pagespace/db/db', () => ({ getMigrationDb: () => ({ select: mockSelect, update: mockUpdate }) }));
vi.mock('@pagespace/db/schema/agent-sessions', () => ({
  agentSessions: { id: 'agentSessions.id', workspaceState: 'agentSessions.workspaceState' },
}));
vi.mock('@pagespace/db/schema/conversations', () => ({
  conversations: { id: 'conversations.id', sessionId: 'conversations.sessionId', closedInSessionAt: 'conversations.closedInSessionAt' },
}));
// `eq`/`and`/`isNull` return plain, inspectable predicate objects instead of
// a real SQL AST — enough for the mocked `update().set().where()` chain
// below to read back which conversationId a call targeted.
vi.mock('@pagespace/db/operators', () => ({
  and: (...predicates: unknown[]) => ({ and: predicates }),
  eq: (column: unknown, value: unknown) => ({ column, value }),
  isNull: (column: unknown) => ({ isNull: column }),
  sql: (strings: TemplateStringsArray) => strings.join(''),
}));

import { findOrphanedBackgroundTabIds, runBackfill, type RawWorkspaceState } from '../backfill-close-orphaned-tab-listings';

const scope = (targetId: string | null) => ({ targetId });

describe('findOrphanedBackgroundTabIds', () => {
  it('given a pane with no tabs array at all (already migrated, or never had tabs), finds nothing', () => {
    const workspace: RawWorkspaceState = { columns: [{ panes: [{ scope: scope('conv-1') }] }] };
    expect(findOrphanedBackgroundTabIds(workspace)).toEqual(new Set());
  });

  it('given a pane with a single-entry tabs array (the common post-tabs shape), finds nothing', () => {
    const workspace: RawWorkspaceState = {
      columns: [{ panes: [{ scope: scope('conv-1'), tabs: [scope('conv-1')] }] }],
    };
    expect(findOrphanedBackgroundTabIds(workspace)).toEqual(new Set());
  });

  it('given a pane with a genuine multi-tab legacy shape, finds every tab OTHER than the active one', () => {
    const workspace: RawWorkspaceState = {
      columns: [{ panes: [{ scope: scope('conv-1'), tabs: [scope('conv-1'), scope('conv-2'), scope('conv-3')] }] }],
    };
    expect(findOrphanedBackgroundTabIds(workspace)).toEqual(new Set(['conv-2', 'conv-3']));
  });

  it('collects orphans across every pane and column, deduplicating repeats', () => {
    const workspace: RawWorkspaceState = {
      columns: [
        { panes: [{ scope: scope('conv-1'), tabs: [scope('conv-1'), scope('conv-9')] }] },
        {
          panes: [
            { scope: scope('conv-5'), tabs: [scope('conv-5'), scope('conv-9')] }, // conv-9 repeated
            { scope: null, tabs: [] },
          ],
        },
      ],
    };
    expect(findOrphanedBackgroundTabIds(workspace)).toEqual(new Set(['conv-9']));
  });

  it("never closes a conversation that is a background tab in one pane but ANOTHER pane's own active scope", () => {
    const workspace: RawWorkspaceState = {
      columns: [
        {
          panes: [
            { scope: scope('conv-3'), tabs: [scope('conv-2'), scope('conv-3')] },
            { scope: scope('conv-2'), tabs: [scope('conv-2')] },
          ],
        },
      ],
    };
    expect(findOrphanedBackgroundTabIds(workspace)).toEqual(new Set());
  });

  it('given a still-loading active scope (targetId null), never mistakes it for an orphan', () => {
    const workspace: RawWorkspaceState = {
      columns: [{ panes: [{ scope: scope(null), tabs: [scope(null), scope('conv-2')] }] }],
    };
    expect(findOrphanedBackgroundTabIds(workspace)).toEqual(new Set(['conv-2']));
  });

  it('given null/undefined workspace state, returns an empty set rather than throwing', () => {
    expect(findOrphanedBackgroundTabIds(null)).toEqual(new Set());
    expect(findOrphanedBackgroundTabIds(undefined)).toEqual(new Set());
  });
});

/** Chainable select stub resolving to `rows` on `.where()`. */
function stubSelect(rows: unknown[]) {
  const stub: Record<string, unknown> = {};
  stub.from = () => stub;
  stub.where = () => Promise.resolve(rows);
  return stub;
}

/**
 * Chainable update stub: `.set().where(predicate).returning()` resolves to
 * `[{id}]` (closed) unless `conversationId` is in `alreadyClosed`, mirroring
 * the real query's `isNull(closedInSessionAt)` filter matching zero rows.
 */
function stubUpdate(alreadyClosed: Set<string>) {
  return (predicate: { and: { column: string; value: string }[] }) => {
    const idPredicate = predicate.and.find((p) => p.column === 'conversations.id');
    const conversationId = idPredicate!.value;
    return Promise.resolve(alreadyClosed.has(conversationId) ? [] : [{ id: conversationId }]);
  };
}

describe('runBackfill', () => {
  it('closes every orphaned background tab exactly once, skips already-migrated sessions, and reports accurate counts', async () => {
    mockSelect.mockReturnValue(
      stubSelect([
        {
          id: 'ses-1',
          workspaceState: {
            columns: [{ panes: [{ scope: scope('conv-1'), tabs: [scope('conv-1'), scope('conv-2'), scope('conv-3')] }] }],
          },
        },
        // Already migrated (or never had tabs) — nothing to do here.
        { id: 'ses-2', workspaceState: { columns: [{ panes: [{ scope: scope('conv-9') }] }] } },
      ]),
    );
    mockUpdate.mockReturnValue({
      set: () => ({ where: (predicate: unknown) => ({ returning: () => stubUpdate(new Set(['conv-3']))(predicate as never) }) }),
    });

    const result = await runBackfill();

    expect(result.sessionsWithOrphans).toBe(1);
    // conv-2 closes; conv-3 was already closed/moved (simulated above).
    expect(result.closed).toBe(1);
    expect(result.alreadyClosed).toBe(1);
  });

  it('given no sessions with orphaned tabs, closes nothing', async () => {
    mockSelect.mockReturnValue(
      stubSelect([{ id: 'ses-1', workspaceState: { columns: [{ panes: [{ scope: scope('conv-1') }] }] } }]),
    );
    mockUpdate.mockClear();

    const result = await runBackfill();

    expect(result).toEqual({ sessionsWithOrphans: 0, closed: 0, alreadyClosed: 0 });
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
