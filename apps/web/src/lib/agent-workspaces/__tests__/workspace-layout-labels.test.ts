// @vitest-environment node
/**
 * PANE LABELS ARE A PERMISSIONED JOIN (security review HIGH 1).
 *
 * The layout read path derives every pane's display label by joining the
 * conversation title / shell name / page title at read time. Before this
 * suite existed the join took NO viewer: `resolvePaneLabels` selected the
 * titles by id and every consumer (`GET /workspace`, the verbs route's 200
 * and its 409 body, the `workspace:updated` broadcast, and `list_panes`)
 * returned them verbatim. Two disclosures followed:
 *
 *  - **Attack A (redaction bypass).** `list_sessions`' shared listing hands a
 *    drive member the workspace ids of OTHER members' workspaces with the
 *    conversation titles correctly redacted. Reading the same workspace's
 *    layout returned the real titles in `grid[].panes[].scope.name` — the
 *    redaction rule undone one HTTP call later.
 *  - **Attack B (universal title oracle).** A pane's `targetId` is whatever
 *    the verb that bound it supplied. Anyone with a workspace of their own
 *    could bind an arbitrary conversation / shell / page id and read the
 *    resolved title back out, over resources they have no access to at all.
 *
 * The rule these tests pin, per pane kind:
 *  - `chat`   — resolve only when the conversation is genuinely IN this
 *               workspace, or is one the viewer may access on its own footing
 *               (`canAccessConversation`); then the title still passes through
 *               `redactConversationTitleForViewer`, the epic's ONE listing rule.
 *  - `terminal` — resolve only when the shell belongs to THIS workspace
 *               (shells are workspace-scoped, so containment is exact and
 *               matches what the shells route already serves).
 *  - `page`   — resolve only when the viewer has page access
 *               (`getUserAccessLevel`).
 * Anything else keeps its pane ROW and resolves no label at all — the same
 * empty-name treatment a deleted target has always had.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LayoutGridColumn } from '@pagespace/lib/agent-workspaces/workspace-layout-verbs';
import type { WorkspaceLayoutStore } from '@pagespace/lib/services/agent-workspaces/workspace-layout-store';

const { storeRef, rows, pageAccess, mockBroadcast } = vi.hoisted(() => ({
  storeRef: { current: null as unknown },
  rows: {
    conversations: [] as unknown[],
    shells: [] as unknown[],
    pages: [] as unknown[],
    workspaces: [] as unknown[],
  },
  /** `${viewerId}:${pageId}` the viewer may read. Everything else denies. */
  pageAccess: new Set<string>(),
  mockBroadcast: vi.fn(),
}));

vi.mock('@pagespace/lib/services/agent-workspaces/workspace-layout-store', () => ({
  withWorkspaceLayoutLock: async (_workspaceId: string, fn: (tx: unknown) => Promise<unknown>) => fn({}),
  createDbWorkspaceLayoutStore: async () => storeRef.current,
}));
vi.mock('@/lib/websocket/agent-workspace-events', () => ({
  broadcastWorkspaceUpdated: (...args: unknown[]) => mockBroadcast(...args),
}));
vi.mock('@pagespace/db/db', () => ({
  db: {
    select: () => ({
      from: (table: { __name: keyof typeof rows }) => ({
        where: async () => rows[table.__name],
      }),
    }),
  },
}));
vi.mock('@pagespace/db/operators', () => ({ inArray: vi.fn() }));
vi.mock('@pagespace/db/schema/conversations', () => ({ conversations: { __name: 'conversations' } }));
vi.mock('@pagespace/db/schema/agent-workspaces', () => ({
  agentWorkspaceShells: { __name: 'shells' },
  agentWorkspaces: { __name: 'workspaces' },
}));
vi.mock('@pagespace/db/schema/core', () => ({ pages: { __name: 'pages' } }));
vi.mock('@pagespace/lib/permissions/permissions', () => ({
  getUserAccessLevel: async (userId: string, pageId: string) =>
    pageAccess.has(`${userId}:${pageId}`) ? 'VIEW' : null,
}));

import { readWorkspaceLayoutSnapshot, readWorkspaceGridsBulk } from '../workspace-layout-runtime';

const ALICE = 'alice';
const MALLORY = 'mallory';
const WORKSPACE = 'ws-alice';
const MALLORY_WORKSPACE = 'ws-mallory';

function createFakeStore(grids: Record<string, LayoutGridColumn[]>): WorkspaceLayoutStore {
  return {
    async getWorkspaceGrid(workspaceId) {
      return structuredClone(grids[workspaceId] ?? []);
    },
    async getWorkspaceGridsBulk(workspaceIds) {
      const out = new Map<string, LayoutGridColumn[]>();
      for (const id of workspaceIds) {
        const grid = grids[id];
        if (grid && grid.length > 0) out.set(id, structuredClone(grid));
      }
      return out;
    },
    async replaceWorkspaceGrid() {
      return { rev: 1, applied: true };
    },
    async currentRev() {
      return 1;
    },
    async findOp() {
      return null;
    },
    async recordOp() {},
  };
}

/** One column, one pane, bound to `kind:targetId`. */
const gridOf = (kind: 'chat' | 'terminal' | 'page', targetId: string): LayoutGridColumn[] => [
  { id: 'col-1', widthFraction: null, panes: [{ id: 'pane-1', kind, targetId, heightFraction: null }] },
];

const nameOf = (grid: NonNullable<Awaited<ReturnType<typeof readWorkspaceLayoutSnapshot>>['grid']>): string =>
  grid[0].panes[0].scope?.name ?? '<unbound>';

beforeEach(() => {
  vi.clearAllMocks();
  pageAccess.clear();
  rows.conversations = [];
  rows.shells = [];
  rows.pages = [];
  // Alice owns her workspace; Mallory owns his.
  rows.workspaces = [
    { id: WORKSPACE, ownerId: ALICE },
    { id: MALLORY_WORKSPACE, ownerId: MALLORY },
  ];
});

describe('Attack A — a drive member reading someone else\'s workspace layout', () => {
  beforeEach(() => {
    // A private thread of Alice's, genuinely living in Alice's workspace.
    rows.conversations = [
      {
        id: 'conv-private',
        title: 'Q3 layoffs plan',
        type: 'global',
        contextId: null,
        userId: ALICE,
        isShared: false,
        workspaceId: WORKSPACE,
      },
    ];
    storeRef.current = createFakeStore({ [WORKSPACE]: gridOf('chat', 'conv-private') });
  });

  it('gives the workspace OWNER the real title (shared-workspace semantics are unchanged)', async () => {
    const snapshot = await readWorkspaceLayoutSnapshot(WORKSPACE, ALICE);
    expect(nameOf(snapshot.grid!)).toBe('Q3 layoffs plan');
  });

  it('redacts the title for any other viewer — the SAME rule list_sessions applies', async () => {
    const snapshot = await readWorkspaceLayoutSnapshot(WORKSPACE, MALLORY);
    expect(nameOf(snapshot.grid!)).toBe('(private thread)');
    // The pane ROW survives — redaction hides the title, not the layout.
    expect(snapshot.grid![0].panes[0].scope?.targetId).toBe('conv-private');
  });

  it('still shows a DELIBERATELY SHARED thread to another viewer', async () => {
    (rows.conversations[0] as { isShared: boolean }).isShared = true;
    const snapshot = await readWorkspaceLayoutSnapshot(WORKSPACE, MALLORY);
    expect(nameOf(snapshot.grid!)).toBe('Q3 layoffs plan');
  });
});

describe('Attack B — an arbitrary targetId bound into the attacker\'s OWN workspace', () => {
  it('resolves no conversation title for a foreign conversation, even for the workspace owner', async () => {
    rows.conversations = [
      {
        id: 'conv-victim',
        title: 'Board deck v4',
        type: 'global',
        contextId: null,
        userId: ALICE,
        isShared: false,
        workspaceId: WORKSPACE,
      },
    ];
    storeRef.current = createFakeStore({ [MALLORY_WORKSPACE]: gridOf('chat', 'conv-victim') });

    const snapshot = await readWorkspaceLayoutSnapshot(MALLORY_WORKSPACE, MALLORY);
    expect(nameOf(snapshot.grid!)).toBe('');
  });

  it('DOES resolve a foreign conversation the viewer may access on its own footing', async () => {
    // Not in Mallory's workspace, but deliberately shared on a page he can
    // view — `canAccessConversation`'s rule, the same predicate the conv: room
    // join and /stream-join enforce. Refusing this would break a legitimate
    // pane; the gate is authority, not containment for its own sake.
    rows.conversations = [
      {
        id: 'conv-shared',
        title: 'Team retro',
        type: 'page',
        contextId: 'page-team',
        userId: ALICE,
        isShared: true,
        workspaceId: WORKSPACE,
      },
    ];
    pageAccess.add(`${MALLORY}:page-team`);
    storeRef.current = createFakeStore({ [MALLORY_WORKSPACE]: gridOf('chat', 'conv-shared') });

    const snapshot = await readWorkspaceLayoutSnapshot(MALLORY_WORKSPACE, MALLORY);
    expect(nameOf(snapshot.grid!)).toBe('Team retro');
  });

  it('refuses that same shared conversation once the viewer loses the page', async () => {
    rows.conversations = [
      {
        id: 'conv-shared',
        title: 'Team retro',
        type: 'page',
        contextId: 'page-team',
        userId: ALICE,
        isShared: true,
        workspaceId: WORKSPACE,
      },
    ];
    // No page access this time.
    storeRef.current = createFakeStore({ [MALLORY_WORKSPACE]: gridOf('chat', 'conv-shared') });

    const snapshot = await readWorkspaceLayoutSnapshot(MALLORY_WORKSPACE, MALLORY);
    expect(nameOf(snapshot.grid!)).toBe('');
  });

  it('resolves no shell name for a shell belonging to a different workspace', async () => {
    rows.shells = [{ id: 'shell-victim', name: 'prod-deploy-key-rotation', workspaceId: WORKSPACE }];
    storeRef.current = createFakeStore({ [MALLORY_WORKSPACE]: gridOf('terminal', 'shell-victim') });

    const snapshot = await readWorkspaceLayoutSnapshot(MALLORY_WORKSPACE, MALLORY);
    expect(nameOf(snapshot.grid!)).toBe('');
  });

  it('resolves the shell name when the shell really belongs to the workspace being read', async () => {
    rows.shells = [{ id: 'shell-own', name: 'build', workspaceId: MALLORY_WORKSPACE }];
    storeRef.current = createFakeStore({ [MALLORY_WORKSPACE]: gridOf('terminal', 'shell-own') });

    const snapshot = await readWorkspaceLayoutSnapshot(MALLORY_WORKSPACE, MALLORY);
    expect(nameOf(snapshot.grid!)).toBe('build');
  });

  it('resolves no page title for a page the viewer cannot read', async () => {
    rows.pages = [{ id: 'page-secret', title: 'Acquisition targets' }];
    storeRef.current = createFakeStore({ [MALLORY_WORKSPACE]: gridOf('page', 'page-secret') });

    const snapshot = await readWorkspaceLayoutSnapshot(MALLORY_WORKSPACE, MALLORY);
    expect(nameOf(snapshot.grid!)).toBe('');
  });

  it('resolves the page title when the viewer CAN read the page', async () => {
    rows.pages = [{ id: 'page-ok', title: 'Sprint notes' }];
    pageAccess.add(`${MALLORY}:page-ok`);
    storeRef.current = createFakeStore({ [MALLORY_WORKSPACE]: gridOf('page', 'page-ok') });

    const snapshot = await readWorkspaceLayoutSnapshot(MALLORY_WORKSPACE, MALLORY);
    expect(nameOf(snapshot.grid!)).toBe('Sprint notes');
  });
});

describe('a null viewer resolves NOTHING', () => {
  it('returns a label-free grid — the shape the room broadcast ships', async () => {
    rows.conversations = [
      {
        id: 'conv-1',
        title: 'Anything',
        type: 'global',
        contextId: null,
        userId: ALICE,
        isShared: true,
        workspaceId: WORKSPACE,
      },
    ];
    storeRef.current = createFakeStore({ [WORKSPACE]: gridOf('chat', 'conv-1') });

    const snapshot = await readWorkspaceLayoutSnapshot(WORKSPACE, null);
    expect(nameOf(snapshot.grid!)).toBe('');
    expect(snapshot.grid![0].panes[0].scope?.targetId).toBe('conv-1');
  });
});

describe('the bulk read applies the same per-workspace rule', () => {
  it('redacts per workspace, not per query — one viewer, two workspaces', async () => {
    rows.conversations = [
      {
        id: 'conv-alice',
        title: 'Alice private',
        type: 'global',
        contextId: null,
        userId: ALICE,
        isShared: false,
        workspaceId: WORKSPACE,
      },
      {
        id: 'conv-mallory',
        title: 'Mallory own',
        type: 'global',
        contextId: null,
        userId: MALLORY,
        isShared: false,
        workspaceId: MALLORY_WORKSPACE,
      },
    ];
    storeRef.current = createFakeStore({
      [WORKSPACE]: gridOf('chat', 'conv-alice'),
      [MALLORY_WORKSPACE]: gridOf('chat', 'conv-mallory'),
    });

    const grids = await readWorkspaceGridsBulk([WORKSPACE, MALLORY_WORKSPACE], MALLORY);
    expect(grids.get(WORKSPACE)![0].panes[0].scope?.name).toBe('(private thread)');
    expect(grids.get(MALLORY_WORKSPACE)![0].panes[0].scope?.name).toBe('Mallory own');
  });
});
