/**
 * The store's own job: identity, idempotence, the CLIENT-ONLY guards the
 * server's reducer deliberately cannot evaluate (dirty panes, live
 * conversations, the invoking pane), and not blowing up on a transition aimed
 * at a grid that is gone. The layout rules themselves are the reducer's, and
 * are tested there; the queue PROTOCOL is tested in
 * `workspace-verb-queue.test.ts`.
 *
 * Every mutation here also mints a verb and posts it. This suite deliberately
 * runs on a transport that never settles: what it pins is the OPTIMISTIC
 * state — what the user sees the instant they click, before any server has
 * answered — which is exactly the behavior the pre-verb store had and must
 * keep having.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { PaneScope } from '@pagespace/lib/agent-workspaces/contract';
import { useAgentWorkspaceStore, __resetWorkspaceQueuesForTests } from '../useAgentWorkspaceStore';
import { panesOf } from '../pane-reducer';
import { useEditingStore } from '@/stores/useEditingStore';

const mockFetchWithAuth = vi.fn();
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

const scope = (name = 'Planning'): PaneScope => ({
  kind: 'chat',
  name,
  targetId: 'conv-1',
  agentPageId: 'agent-1',
});

const store = () => useAgentWorkspaceStore.getState();
const grid = (id = 'ses-1') => store().workspaces[id];

beforeEach(() => {
  mockFetchWithAuth.mockReset();
  // A transport that never answers: every verb stays queued, so what these
  // assertions read is purely the optimistic apply.
  mockFetchWithAuth.mockImplementation(() => new Promise<Response>(() => {}));
  __resetWorkspaceQueuesForTests();
  useAgentWorkspaceStore.setState({ workspaces: {}, sync: {}, focus: {} });
});

describe('ensureWorkspace', () => {
  it('should open a session on one pane bound to its first conversation', () => {
    store().ensureWorkspace('ses-1', scope());
    expect(panesOf(grid())).toHaveLength(1);
    expect(panesOf(grid())[0].scope).toEqual(scope());
  });

  it('should be idempotent — re-opening a session must not discard its layout', () => {
    store().ensureWorkspace('ses-1', scope());
    store().splitRight('ses-1', grid().activePaneId);
    expect(panesOf(grid())).toHaveLength(2);

    store().ensureWorkspace('ses-1', scope());

    expect(panesOf(grid())).toHaveLength(2);
  });

  it('should keep sessions independent', () => {
    store().ensureWorkspace('ses-1', scope());
    store().ensureWorkspace('ses-2', { ...scope('Other'), targetId: 'conv-2' });
    store().splitRight('ses-1', grid('ses-1').activePaneId);

    expect(panesOf(grid('ses-1'))).toHaveLength(2);
    expect(panesOf(grid('ses-2'))).toHaveLength(1);
  });
});

describe('pane ids', () => {
  it('should mint distinct ids for every pane', () => {
    store().ensureWorkspace('ses-1', scope());
    store().splitRight('ses-1', grid().activePaneId);
    store().splitDown('ses-1', grid().activePaneId);

    const ids = panesOf(grid()).map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('should mint distinct column ids across split-rights', () => {
    store().ensureWorkspace('ses-1', scope());
    store().splitRight('ses-1', grid().activePaneId);
    store().splitRight('ses-1', grid().activePaneId);

    const columnIds = grid().columns.map((c) => c.id);
    expect(new Set(columnIds).size).toBe(columnIds.length);
  });
});

describe('transitions', () => {
  beforeEach(() => {
    store().ensureWorkspace('ses-1', scope());
  });

  it('should bind a pane through assignPane', () => {
    store().splitRight('ses-1', grid().activePaneId);
    const target = grid().activePaneId;
    const shell: PaneScope = { kind: 'terminal', name: 'shell-1', targetId: 'shell-9', agentPageId: null };

    store().assignPane('ses-1', target, shell);

    expect(panesOf(grid()).find((p) => p.id === target)?.scope).toEqual(shell);
  });

  it('should close a pane and keep the grid non-empty', () => {
    store().splitRight('ses-1', grid().activePaneId);
    store().closePane('ses-1', grid().activePaneId);
    expect(panesOf(grid())).toHaveLength(1);
  });

  it('closing the LAST pane ends the session — the grid is removed and the caller told to end it', () => {
    // The container-level interception the old closePaneIn owned: the pure
    // reducer no-ops (it cannot delete its own container), the store CAN, and
    // the return value is how the caller knows to tear the sandbox down.
    const verdict = store().closePane('ses-1', grid().activePaneId);
    expect(verdict).toBe('session-ended');
    expect(store().workspaces['ses-1']).toBeUndefined();
  });

  it('closing a NON-last pane reports closed and keeps the grid', () => {
    store().splitRight('ses-1', grid().activePaneId);
    const verdict = store().closePane('ses-1', grid().activePaneId);
    expect(verdict).toBe('closed');
    expect(panesOf(grid())).toHaveLength(1);
  });

  it('closing an unknown pane reports noop', () => {
    expect(store().closePane('ses-1', 'ghost')).toBe('noop');
    expect(store().closePane('never-existed', 'ghost')).toBe('noop');
  });
});

describe('resetPane', () => {
  beforeEach(() => {
    store().ensureWorkspace('ses-1', scope());
  });

  it('should unbind the pane so it renders the picker again', () => {
    store().resetPane('ses-1', grid().activePaneId);
    expect(panesOf(grid())[0].scope).toBeNull();
  });

  it('should no-op against a grid that is gone', () => {
    store().forgetWorkspace('ses-1');
    expect(() => store().resetPane('ses-1', 'pane-1')).not.toThrow();
    expect(store().workspaces['ses-1']).toBeUndefined();
  });
});

describe('replaceConversation — pruning the pane a deleted conversation left behind', () => {
  const replacement: PaneScope = { kind: 'chat', name: 'New conversation', targetId: 'conv-new', agentPageId: 'agent-1' };

  it('should assign the pane that was showing the deleted conversation to its replacement', () => {
    store().ensureWorkspace('ses-1', scope());
    const paneId = grid().activePaneId;

    store().replaceConversation('ses-1', 'conv-1', replacement);

    expect(panesOf(grid()).find((p) => p.id === paneId)?.scope).toEqual(replacement);
  });

  it('should target the pane holding the OLD id even when it is not the active pane', () => {
    store().ensureWorkspace('ses-1', scope());
    const original = grid().activePaneId;
    store().splitRight('ses-1', original);
    // The split moved active focus to the new pane; the deleted conversation
    // is still in the ORIGINAL one.
    expect(grid().activePaneId).not.toBe(original);

    store().replaceConversation('ses-1', 'conv-1', replacement);

    expect(panesOf(grid()).find((p) => p.id === original)?.scope).toEqual(replacement);
  });

  it('given a conversation shown nowhere, should no-op', () => {
    store().ensureWorkspace('ses-1', scope());
    expect(() => store().replaceConversation('ses-1', 'never-shown', replacement)).not.toThrow();
    expect(panesOf(grid())[0].scope).toEqual(scope());
  });

  it('should no-op against a grid that is gone', () => {
    expect(() => store().replaceConversation('never-existed', 'conv-1', replacement)).not.toThrow();
  });
});

describe('a transition aimed at a grid that is gone', () => {
  it('should no-op rather than throw or fabricate one', () => {
    // A close can land after the conversation was deleted and its grid
    // forgotten. There is nothing meaningful to build from a split of something
    // absent, so the store declines rather than inventing a workspace.
    expect(() => store().splitRight('never-existed', 'pane-x')).not.toThrow();
    expect(store().workspaces['never-existed']).toBeUndefined();

    store().ensureWorkspace('ses-1', scope());
    store().forgetWorkspace('ses-1');
    expect(() => store().closePane('ses-1', 'pane-1')).not.toThrow();
    expect(store().workspaces['ses-1']).toBeUndefined();
  });

  it('forgetWorkspace should be safe to call twice', () => {
    store().ensureWorkspace('ses-1', scope());
    store().forgetWorkspace('ses-1');
    expect(() => store().forgetWorkspace('conv-1')).not.toThrow();
  });
});

describe('openConversation — selection means SHOW it (review M1)', () => {
  const conv = (targetId: string, name = 'Thread'): PaneScope => ({
    kind: 'chat',
    name,
    targetId,
    agentPageId: 'agent-1',
  });
  const shellScope = (targetId: string): PaneScope => ({
    kind: 'terminal',
    name: 'shell-1',
    targetId,
    agentPageId: null,
  });

  it('with no workspace, seeds the opening grid (ensure semantics)', () => {
    store().openConversation('ses-1', conv('conv-1'));
    expect(panesOf(grid())).toHaveLength(1);
    expect(panesOf(grid())[0].scope?.targetId).toBe('conv-1');
  });

  it('focuses the pane already showing the conversation instead of duplicating it', () => {
    store().openConversation('ses-1', conv('conv-1'));
    const first = panesOf(grid())[0];
    store().splitRight('ses-1', first.id);
    const second = panesOf(grid()).find((p) => p.id !== first.id)!;
    store().assignPane('ses-1', second.id, conv('conv-2'));
    expect(grid().activePaneId).toBe(second.id);

    store().openConversation('ses-1', conv('conv-1'));
    expect(grid().activePaneId).toBe(first.id);
    expect(panesOf(grid())).toHaveLength(2);
  });

  it('opens an unseen conversation in the ACTIVE pane when it is a chat', () => {
    store().openConversation('ses-1', conv('conv-1'));
    const paneId = panesOf(grid())[0].id;
    store().openConversation('ses-1', conv('conv-2'));
    expect(panesOf(grid())).toHaveLength(1);
    expect(panesOf(grid())[0].id).toBe(paneId);
    expect(panesOf(grid())[0].scope?.targetId).toBe('conv-2');
  });

  it('never opens OVER a terminal — a running PTY keeps its only surface', () => {
    store().openConversation('ses-1', conv('conv-1'));
    const chatPane = panesOf(grid())[0];
    store().splitRight('ses-1', chatPane.id);
    const termPane = panesOf(grid()).find((p) => p.id !== chatPane.id)!;
    store().assignPane('ses-1', termPane.id, shellScope('shell-row-1'));
    // Terminal is the ACTIVE pane now; the open must land on the chat pane.
    store().openConversation('ses-1', conv('conv-2'));
    const term = panesOf(grid()).find((p) => p.id === termPane.id)!;
    expect(term.scope?.kind).toBe('terminal');
    const chat = panesOf(grid()).find((p) => p.id === chatPane.id)!;
    expect(chat.scope?.targetId).toBe('conv-2');
  });

  it('with EVERY pane a terminal, splits right rather than evicting one', () => {
    store().openConversation('ses-1', conv('conv-1'));
    const only = panesOf(grid())[0];
    store().assignPane('ses-1', only.id, shellScope('shell-row-1'));

    store().openConversation('ses-1', conv('conv-2'));
    const panes = panesOf(grid());
    expect(panes).toHaveLength(2);
    expect(panes.filter((p) => p.scope?.kind === 'terminal')).toHaveLength(1);
    expect(panes.find((p) => p.scope?.targetId === 'conv-2')).toBeDefined();
  });

  it('never clobbers a pane whose mint is still in flight (review low-batch #1)', () => {
    // The active pane is bound to a KIND but has no row yet (the picker just
    // chose it, the POST hasn't resolved) — picking a DIFFERENT conversation
    // from history in the meantime must not land on top of it, or the mint's
    // own success callback later overwrites the user's newer selection.
    store().openConversation('ses-1', conv('conv-1'));
    const inFlightPane = panesOf(grid())[0];
    store().assignPane('ses-1', inFlightPane.id, {
      kind: 'chat',
      name: 'New conversation',
      targetId: null,
      agentPageId: 'agent-2',
    });

    store().openConversation('ses-1', conv('conv-2'));

    const panes = panesOf(grid());
    expect(panes).toHaveLength(2);
    expect(panes.find((p) => p.id === inFlightPane.id)?.scope?.targetId).toBeNull();
    expect(panes.find((p) => p.scope?.targetId === 'conv-2')).toBeDefined();
  });

  it('never evicts a pane showing a conversation closed-in-session — absent from liveConversationIds', () => {
    store().openConversation('ses-1', conv('conv-1'));
    const closedPane = panesOf(grid())[0];

    store().openConversation('ses-1', conv('conv-2'), { liveConversationIds: new Set(['conv-2']) });

    const panes = panesOf(grid());
    expect(panes).toHaveLength(2);
    expect(panes.find((p) => p.id === closedPane.id)?.scope?.targetId).toBe('conv-1');
    expect(panes.find((p) => p.scope?.targetId === 'conv-2')).toBeDefined();
  });

  it('still evicts a pane whose conversation IS in liveConversationIds', () => {
    store().openConversation('ses-1', conv('conv-1'));
    const paneId = panesOf(grid())[0].id;

    store().openConversation('ses-1', conv('conv-2'), { liveConversationIds: new Set(['conv-1', 'conv-2']) });

    expect(panesOf(grid())).toHaveLength(1);
    expect(panesOf(grid())[0].id).toBe(paneId);
    expect(panesOf(grid())[0].scope?.targetId).toBe('conv-2');
  });

  it('omitting liveConversationIds preserves today\'s eviction behavior — strictly additive/opt-in', () => {
    store().openConversation('ses-1', conv('conv-1'));
    const paneId = panesOf(grid())[0].id;

    store().openConversation('ses-1', conv('conv-2'));

    expect(panesOf(grid())).toHaveLength(1);
    expect(panesOf(grid())[0].id).toBe(paneId);
    expect(panesOf(grid())[0].scope?.targetId).toBe('conv-2');
  });
});

describe('openPage — the page-pane sibling of openConversation', () => {
  const page = (targetId: string, name = 'Doc'): PaneScope => ({
    kind: 'page',
    name,
    targetId,
    agentPageId: null,
  });
  const conv = (targetId: string, name = 'Thread'): PaneScope => ({
    kind: 'chat',
    name,
    targetId,
    agentPageId: 'agent-1',
  });

  afterEach(() => {
    useEditingStore.getState().clearAllSessions();
  });

  it('with no workspace, seeds the opening grid on the page (ensure semantics)', () => {
    store().openPage('ses-1', page('page-1'));
    expect(panesOf(grid())).toHaveLength(1);
    expect(panesOf(grid())[0].scope?.targetId).toBe('page-1');
  });

  it('focuses the pane already showing the page instead of duplicating it', () => {
    store().openPage('ses-1', page('page-1'));
    const first = panesOf(grid())[0];
    store().splitRight('ses-1', first.id);
    const second = panesOf(grid()).find((p) => p.id !== first.id)!;
    store().assignPane('ses-1', second.id, page('page-2'));

    store().openPage('ses-1', page('page-1'));
    expect(grid().activePaneId).toBe(first.id);
    expect(panesOf(grid())).toHaveLength(2);
  });

  it('replaces an unseen page in the ACTIVE pane, same as a conversation would', () => {
    store().openPage('ses-1', page('page-1'));
    const paneId = panesOf(grid())[0].id;
    store().openPage('ses-1', page('page-2'));
    expect(panesOf(grid())).toHaveLength(1);
    expect(panesOf(grid())[0].id).toBe(paneId);
    expect(panesOf(grid())[0].scope?.targetId).toBe('page-2');
  });

  it('never replaces a page pane with unsaved edits — it splits beside it instead', () => {
    store().openPage('ses-1', page('page-1'));
    const dirtyPane = panesOf(grid())[0];
    // A real dirty registration, keyed the way DocumentView/etc actually key it
    // (pageId carried in metadata, a useId()-suffixed componentId — the store's
    // guard reads metadata.pageId, never the componentId string itself).
    useEditingStore.getState().startEditing('document-page-1-:r1:', 'document', { pageId: 'page-1' });

    store().openPage('ses-1', page('page-2'));

    const panes = panesOf(grid());
    expect(panes).toHaveLength(2);
    expect(panes.find((p) => p.id === dirtyPane.id)?.scope?.targetId).toBe('page-1');
    expect(panes.find((p) => p.scope?.targetId === 'page-2')).toBeDefined();
  });

  it('stops treating a page as dirty once its editing session ends', () => {
    store().openPage('ses-1', page('page-1'));
    const onlyPane = panesOf(grid())[0];
    useEditingStore.getState().startEditing('document-page-1-:r1:', 'document', { pageId: 'page-1' });
    useEditingStore.getState().endEditing('document-page-1-:r1:');

    store().openPage('ses-1', page('page-2'));

    expect(panesOf(grid())).toHaveLength(1);
    expect(panesOf(grid())[0].id).toBe(onlyPane.id);
    expect(panesOf(grid())[0].scope?.targetId).toBe('page-2');
  });

  it('never replaces the pane the caller excluded (the open_page_pane tool\'s own invoking chat)', () => {
    // A lone chat pane — exactly the shape a real agent session starts with —
    // must not be evicted by its OWN tool call opening a page beside it.
    store().ensureWorkspace('ses-1', conv('conv-1'));
    const chatPane = panesOf(grid())[0];

    store().openPage('ses-1', page('page-1'), { excludeTargetId: 'conv-1' });

    const panes = panesOf(grid());
    expect(panes).toHaveLength(2);
    expect(panes.find((p) => p.id === chatPane.id)?.scope?.targetId).toBe('conv-1');
    expect(panes.find((p) => p.scope?.targetId === 'page-1')).toBeDefined();
  });

  it('with preferSplit, never evicts ANY bound pane — the agent path splits beside the user\'s panes', () => {
    // The shape from the bug report: agent in conv-1 opens a page while the
    // user is looking at a different page pane. The old policy replaced that
    // active pane; the agent path must add a surface, not navigate one.
    store().ensureWorkspace('ses-1', conv('conv-1'));
    const chatPane = panesOf(grid())[0];
    store().splitRight('ses-1', chatPane.id);
    const otherPane = panesOf(grid()).find((p) => p.id !== chatPane.id)!;
    store().assignPane('ses-1', otherPane.id, page('page-1'));

    store().openPage('ses-1', page('page-2'), { excludeTargetId: 'conv-1', preferSplit: true });

    const panes = panesOf(grid());
    expect(panes).toHaveLength(3);
    expect(panes.find((p) => p.id === chatPane.id)?.scope?.targetId).toBe('conv-1');
    expect(panes.find((p) => p.id === otherPane.id)?.scope?.targetId).toBe('page-1');
    expect(panes.find((p) => p.scope?.targetId === 'page-2')).toBeDefined();
  });

  it('with preferSplit, fills an unbound picker pane rather than splitting a fourth one', () => {
    store().ensureWorkspace('ses-1', conv('conv-1'));
    const chatPane = panesOf(grid())[0];
    store().splitRight('ses-1', chatPane.id);
    const pickerPane = panesOf(grid()).find((p) => p.id !== chatPane.id)!;
    expect(pickerPane.scope).toBeNull();

    store().openPage('ses-1', page('page-1'), { excludeTargetId: 'conv-1', preferSplit: true });

    const panes = panesOf(grid());
    expect(panes).toHaveLength(2);
    expect(panes.find((p) => p.id === pickerPane.id)?.scope?.targetId).toBe('page-1');
  });

  it('with preferSplit, still focuses the pane already showing the page instead of duplicating it', () => {
    store().ensureWorkspace('ses-1', conv('conv-1'));
    const chatPane = panesOf(grid())[0];
    store().splitRight('ses-1', chatPane.id);
    const pagePane = panesOf(grid()).find((p) => p.id !== chatPane.id)!;
    store().assignPane('ses-1', pagePane.id, page('page-1'));
    store().selectPane('ses-1', chatPane.id);

    store().openPage('ses-1', page('page-1'), { excludeTargetId: 'conv-1', preferSplit: true });

    expect(panesOf(grid())).toHaveLength(2);
    expect(grid().activePaneId).toBe(pagePane.id);
  });
});

describe('openConversation must not evict a page pane — the reload-seed shape', () => {
  const page = (targetId: string, name = 'Doc'): PaneScope => ({
    kind: 'page',
    name,
    targetId,
    agentPageId: null,
  });
  const conv = (targetId: string, name = 'Thread'): PaneScope => ({
    kind: 'chat',
    name,
    targetId,
    agentPageId: 'agent-1',
  });

  it('with liveConversationIds supplied, a page pane splits rather than being replaced', () => {
    // The refresh path: the persisted grid holds only an agent-opened page
    // pane (its chat pane was replaced pre-fix, or closed); the mount-time
    // seed re-asserts the URL-selected conversation. The page pane is a
    // deliberate, persisted artifact — the seed must open BESIDE it, or an
    // agent-opened page silently vanishes on every reload.
    store().openPage('ses-1', page('page-1'));
    const pagePane = panesOf(grid())[0];

    store().openConversation('ses-1', conv('conv-1'), { liveConversationIds: new Set(['conv-1']) });

    const panes = panesOf(grid());
    expect(panes).toHaveLength(2);
    expect(panes.find((p) => p.id === pagePane.id)?.scope?.targetId).toBe('page-1');
    expect(panes.find((p) => p.scope?.targetId === 'conv-1')).toBeDefined();
  });

  it('with liveConversationIds supplied, an unbound picker pane is still fillable', () => {
    store().openConversation('ses-1', conv('conv-1'));
    store().splitRight('ses-1', panesOf(grid())[0].id);
    const pickerPane = panesOf(grid()).find((p) => p.scope === null)!;

    store().openConversation('ses-1', conv('conv-2'), { liveConversationIds: new Set(['conv-1', 'conv-2']) });

    const panes = panesOf(grid());
    expect(panes).toHaveLength(2);
    expect(panes.find((p) => p.id === pickerPane.id)?.scope?.targetId).toBe('conv-2');
  });

  it('without liveConversationIds, a page pane remains replaceable — user selection behavior unchanged', () => {
    store().openPage('ses-1', page('page-1'));
    const paneId = panesOf(grid())[0].id;

    store().openConversation('ses-1', conv('conv-1'));

    expect(panesOf(grid())).toHaveLength(1);
    expect(panesOf(grid())[0].id).toBe(paneId);
    expect(panesOf(grid())[0].scope?.targetId).toBe('conv-1');
  });
});

describe('persistence — the grid is gone from localStorage; only focus remains', () => {
  it('is versioned past the grid era, so a v1 payload is retired rather than misread', () => {
    expect(useAgentWorkspaceStore.persist.getOptions().version).toBe(2);
  });

  it('never persists the grid itself — the server is its only home now', () => {
    store().ensureWorkspace('ses-1', scope());
    const persisted = useAgentWorkspaceStore.persist.getOptions().partialize!(store());
    expect(persisted).not.toHaveProperty('workspaces');
    expect(persisted).not.toHaveProperty('sync');
  });

  it('persists the client-local focus, which no row owns', () => {
    store().ensureWorkspace('ses-1', scope());
    const persisted = useAgentWorkspaceStore.persist.getOptions().partialize!(store()) as {
      focus: Record<string, { activePaneId: string }>;
    };
    expect(persisted.focus['ses-1'].activePaneId).toBe(grid().activePaneId);
  });

  it('drops a corrupted focus record on rehydrate rather than letting it reach the store', async () => {
    const storage = useAgentWorkspaceStore.persist.getOptions().storage;
    expect(storage).toBeDefined();
    await storage!.setItem('agent-workspace-storage', {
      state: { focus: { 'ses-1': { activePaneId: 42, pendingPickerPaneId: null } } },
      version: 2,
    } as never);

    await useAgentWorkspaceStore.persist.rehydrate();

    expect(store().focus).toEqual({});
  });

  it('restores a valid focus record', async () => {
    const storage = useAgentWorkspaceStore.persist.getOptions().storage;
    await storage!.setItem('agent-workspace-storage', {
      state: { focus: { 'ses-1': { activePaneId: 'pane-x', pendingPickerPaneId: null } } },
      version: 2,
    });

    await useAgentWorkspaceStore.persist.rehydrate();

    expect(store().focus['ses-1']).toEqual({ activePaneId: 'pane-x', pendingPickerPaneId: null });
  });
});

describe('hydrateWorkspace', () => {
  it('seeds a session from a server-saved grid, unconditionally overwriting whatever is there', () => {
    store().ensureWorkspace('ses-1', scope());
    store().splitRight('ses-1', grid().activePaneId);
    expect(panesOf(grid())).toHaveLength(2);

    const saved = {
      id: 'ses-1',
      columns: [{ id: 'col-x', panes: [{ id: 'pane-x', scope: scope('Restored') }] }],
      activePaneId: 'pane-x',
      pendingPickerPaneId: null,
    };
    store().hydrateWorkspace('ses-1', saved);

    expect(grid()).toEqual(saved);
  });

  it('ignores a saved grid whose id does not match the target session', () => {
    store().ensureWorkspace('ses-1', scope());
    const before = grid();

    const wrongSession = {
      id: 'ses-OTHER',
      columns: [{ id: 'col-x', panes: [{ id: 'pane-x', scope: scope('Restored') }] }],
      activePaneId: 'pane-x',
      pendingPickerPaneId: null,
    };
    store().hydrateWorkspace('ses-1', wrongSession);

    expect(grid()).toEqual(before);
  });

  it('normalizes activePaneId to the first pane when the saved value names no real pane', () => {
    // The persisted schema doesn't cross-validate that activePaneId points
    // at a pane inside columns — a saved grid restored from the server
    // isn't guaranteed to satisfy that invariant (review finding).
    store().ensureWorkspace('ses-1', scope());
    const saved = {
      id: 'ses-1',
      columns: [
        { id: 'col-x', panes: [{ id: 'pane-x', scope: scope('Restored') }] },
        { id: 'col-y', panes: [{ id: 'pane-y', scope: scope('Also restored') }] },
      ],
      activePaneId: 'ghost',
      pendingPickerPaneId: null,
    };
    store().hydrateWorkspace('ses-1', saved);

    expect(grid().activePaneId).toBe('pane-x');
    // Nothing else about the grid was touched.
    expect(grid().columns).toEqual(saved.columns);
  });
});
