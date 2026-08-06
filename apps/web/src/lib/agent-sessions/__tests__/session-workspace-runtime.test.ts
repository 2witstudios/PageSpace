/**
 * `getSessionWorkspace`/`getSessionWorkspacesBulk` — a plain single-column
 * read, so what's worth pinning is just the shape of the query built and the
 * null-when-unsaved fallback, not any decision logic (there is none here on
 * purpose — access control lives in the route, not this module; the WRITE
 * moved to `workspace-layout-runtime.ts` with the Phase 3 dual-write).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/db/db', () => {
  const responses: unknown[][] = [];
  // `.where()` is the terminal call for the BULK query (no `.limit()`
  // follows) but a pass-through for the single-row query (`.limit(1)` comes
  // next) — thenable, so `await` works whichever one the caller stops at.
  const selectChain = {
    select: vi.fn(() => selectChain),
    from: vi.fn(() => selectChain),
    where: vi.fn(() => selectChain),
    limit: vi.fn(() => Promise.resolve(responses.shift() ?? [])),
    then: (resolve: (rows: unknown[]) => void) => resolve(responses.shift() ?? []),
  };
  const db = {
    select: selectChain.select,
    from: selectChain.from,
    where: selectChain.where,
    limit: selectChain.limit,
  };
  return { db, __queueResponse: (rows: unknown[]) => responses.push(rows) };
});
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((col, val) => ({ op: 'eq', col, val })),
  inArray: vi.fn((col, vals) => ({ op: 'inArray', col, vals })),
}));
vi.mock('@pagespace/db/schema/agent-sessions', () => ({
  agentSessions: { id: 'agentSessions.id', workspaceState: 'agentSessions.workspaceState' },
}));

import * as dbModule from '@pagespace/db/db';
import type { PersistedWorkspaceState } from '@pagespace/lib/agent-sessions/contract';
import { getSessionWorkspace, getSessionWorkspacesBulk } from '../session-workspace-runtime';

const queueResponse = (rows: unknown[]) => (dbModule as unknown as { __queueResponse(rows: unknown[]): void }).__queueResponse(rows);

const workspace: PersistedWorkspaceState = {
  id: 'ses-1',
  columns: [
    {
      id: 'col-1',
      panes: [
        {
          id: 'pane-1',
          scope: { kind: 'chat', name: 'Conversation', targetId: 'conv-1', agentPageId: null },
        },
      ],
    },
  ],
  activePaneId: 'pane-1',
  pendingPickerPaneId: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getSessionWorkspace', () => {
  it('returns the saved workspace when one exists', async () => {
    queueResponse([{ workspaceState: workspace }]);
    expect(await getSessionWorkspace('ses-1')).toEqual(workspace);
  });

  it('returns null when the session has never saved a grid', async () => {
    queueResponse([{ workspaceState: null }]);
    expect(await getSessionWorkspace('ses-1')).toBeNull();
  });

  it('returns null when the session row itself is not found', async () => {
    queueResponse([]);
    expect(await getSessionWorkspace('ses-missing')).toBeNull();
  });

  it('returns null for a malformed saved row rather than trusting it as-is', async () => {
    // `columns: []` fails `persistedWorkspaceStateSchema`'s `min(1)` — a row
    // that could only have been written under an older, looser schema
    // (review finding) must not reach callers unvalidated.
    queueResponse([{ workspaceState: { id: 'ses-1', columns: [], activePaneId: 'pane-1', pendingPickerPaneId: null } }]);
    expect(await getSessionWorkspace('ses-1')).toBeNull();
  });
});

describe('getSessionWorkspacesBulk', () => {
  it('given no session ids, returns an empty map without querying', async () => {
    const db = (dbModule as unknown as { db: { select: ReturnType<typeof vi.fn> } }).db;
    expect(await getSessionWorkspacesBulk([])).toEqual(new Map());
    expect(db.select).not.toHaveBeenCalled();
  });

  it('groups saved workspaces by session id, omitting sessions with none saved', async () => {
    queueResponse([
      { id: 'ses-1', workspaceState: workspace },
      { id: 'ses-2', workspaceState: null },
    ]);
    const result = await getSessionWorkspacesBulk(['ses-1', 'ses-2']);
    expect(result.get('ses-1')).toEqual(workspace);
    expect(result.has('ses-2')).toBe(false);
    expect(result.size).toBe(1);
  });

  it('drops a malformed saved row instead of returning it unvalidated', async () => {
    queueResponse([
      { id: 'ses-1', workspaceState: workspace },
      { id: 'ses-2', workspaceState: { id: 'ses-2', columns: [], activePaneId: 'pane-1', pendingPickerPaneId: null } },
    ]);
    const result = await getSessionWorkspacesBulk(['ses-1', 'ses-2']);
    expect(result.get('ses-1')).toEqual(workspace);
    expect(result.has('ses-2')).toBe(false);
    expect(result.size).toBe(1);
  });
});
