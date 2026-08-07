// @vitest-environment node
/**
 * BINDING A PANE IS A PERMISSION DECISION (security review HIGH 1, attack B).
 *
 * `workspaceLayoutVerbSchema` lets `ensure` / `assign_pane` /
 * `open_conversation` / `replace_conversation` carry a free `targetId` +
 * `kind`. The verbs route used to validate session access ONLY — never the
 * scope target — so anyone with a workspace of their own could bind an
 * arbitrary conversation, shell, or page id and read the resolved title back
 * out of the response grid. This is the write half of that fix (the read half
 * is `workspace-layout-labels.test.ts`); belt and braces, because the row a
 * bad bind leaves behind outlives the request that made it.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  workspaceLayoutVerbSchema,
  type WorkspaceLayoutVerb,
} from '@pagespace/lib/agent-workspaces/workspace-layout-verbs';
import { authorizePaneScope, paneScopesOfVerb, type PaneScopeAuthorityDeps } from '../authorize-pane-scope';

const VIEWER = 'viewer-1';
const WORKSPACE = 'ws-1';
const OTHER_WORKSPACE = 'ws-2';

const deps = (overrides: Partial<PaneScopeAuthorityDeps> = {}): PaneScopeAuthorityDeps => ({
  findConversation: vi.fn(async () => null),
  findShellWorkspace: vi.fn(async () => null),
  canViewPage: vi.fn(async () => false),
  ...overrides,
});

const scopeOf = (kind: 'chat' | 'terminal' | 'page', targetId: string | null) => ({
  kind,
  name: 'whatever the caller claims',
  targetId,
  agentPageId: null,
});

describe('paneScopesOfVerb — every verb that can bind a target', () => {
  it('finds the scope on each of the four scope-carrying verbs', () => {
    const scope = scopeOf('chat', 'conv-1');
    const verbs: WorkspaceLayoutVerb[] = [
      { type: 'ensure', columnId: 'c', paneId: 'p', scope },
      { type: 'assign_pane', paneId: 'p', scope },
      { type: 'open_conversation', scope, newColumnId: 'c', newPaneId: 'p' },
      { type: 'replace_conversation', oldTargetId: 'conv-0', scope },
    ];
    for (const verb of verbs) {
      expect(paneScopesOfVerb(verb), `${verb.type} must expose its scope`).toEqual([scope]);
    }
  });

  it('finds nothing on a purely geometric verb', () => {
    expect(paneScopesOfVerb({ type: 'resize_pane', paneId: 'p', heightFraction: 0.5 })).toEqual([]);
    expect(paneScopesOfVerb({ type: 'close_pane', paneId: 'p' })).toEqual([]);
  });

  /**
   * The two tests above enumerate today's verbs, so they pass unchanged when a
   * NEW scope-carrying verb is added and left ungated — which is the one
   * failure that matters here, because an unauthorized pane row outlives the
   * request that wrote it.
   *
   * `paneScopesOfVerb`'s `never` fall-through makes that a compile error, but a
   * type-level guard proves nothing to a reader of the suite and is invisible
   * in a CI log. So this reads the discriminated union at RUNTIME and pins the
   * verb set: adding a verb to `workspaceLayoutVerbSchema` fails here until
   * someone has decided, in this file, which list it belongs in.
   */
  it('pins the verb union, so a new verb cannot be added without classifying it here', () => {
    // No cast: `workspaceLayoutVerbSchema` is a `z.discriminatedUnion`, so
    // `.options[i].shape.type.value` is already typed. An `as unknown as {...}`
    // here would assert the shape rather than read it — and would turn a future
    // change in zod's internals into a silent pass (every `.value` reading
    // `undefined`, `declared` becoming `[undefined × 12]`) instead of the
    // compile error that should stop it.
    const options = workspaceLayoutVerbSchema.options;
    const declared = options.map((o) => o.shape.type.value).sort();

    expect(declared).toEqual(
      [
        'assign_pane',
        'close_pane',
        'ensure',
        'move_pane',
        'open_conversation',
        'reorder_columns',
        'replace_conversation',
        'reset_pane',
        'resize_column',
        'resize_pane',
        'split_down',
        'split_right',
      ].sort(),
    );

    // And the split is exactly the one the gate implements: a verb whose schema
    // declares `scope` must yield it, every other verb must yield nothing.
    const scopeCarrying = options
      .filter((o) => 'scope' in o.shape)
      .map((o) => o.shape.type.value)
      .sort();
    expect(scopeCarrying).toEqual(
      ['assign_pane', 'ensure', 'open_conversation', 'replace_conversation'].sort(),
    );
  });
});

describe('page scopes', () => {
  it('REFUSES a page the caller cannot view — the title oracle over pages', async () => {
    const d = deps({ canViewPage: vi.fn(async () => false) });
    expect(
      await authorizePaneScope({ viewerId: VIEWER, workspaceId: WORKSPACE, scope: scopeOf('page', 'page-secret') }, d),
    ).toBe(false);
    expect(d.canViewPage).toHaveBeenCalledWith(VIEWER, 'page-secret');
  });

  it('allows a page the caller can view', async () => {
    const d = deps({ canViewPage: vi.fn(async () => true) });
    expect(
      await authorizePaneScope({ viewerId: VIEWER, workspaceId: WORKSPACE, scope: scopeOf('page', 'page-ok') }, d),
    ).toBe(true);
  });
});

describe('terminal scopes', () => {
  it('REFUSES a shell that lives in a different workspace', async () => {
    const d = deps({ findShellWorkspace: vi.fn(async () => OTHER_WORKSPACE) });
    expect(
      await authorizePaneScope({ viewerId: VIEWER, workspaceId: WORKSPACE, scope: scopeOf('terminal', 'shell-x') }, d),
    ).toBe(false);
  });

  it('REFUSES a shell that does not exist', async () => {
    const d = deps({ findShellWorkspace: vi.fn(async () => null) });
    expect(
      await authorizePaneScope({ viewerId: VIEWER, workspaceId: WORKSPACE, scope: scopeOf('terminal', 'nope') }, d),
    ).toBe(false);
  });

  it('allows a shell of THIS workspace', async () => {
    const d = deps({ findShellWorkspace: vi.fn(async () => WORKSPACE) });
    expect(
      await authorizePaneScope({ viewerId: VIEWER, workspaceId: WORKSPACE, scope: scopeOf('terminal', 'shell-own') }, d),
    ).toBe(true);
  });
});

describe('chat scopes', () => {
  const conversation = (over: Partial<{ userId: string; isShared: boolean; type: string; contextId: string | null; workspaceId: string | null }>) => ({
    userId: 'someone-else',
    isShared: false,
    type: 'global',
    contextId: null,
    workspaceId: null,
    ...over,
  });

  it('REFUSES a foreign private conversation — the universal title oracle', async () => {
    const d = deps({ findConversation: vi.fn(async () => conversation({ workspaceId: OTHER_WORKSPACE })) });
    expect(
      await authorizePaneScope({ viewerId: VIEWER, workspaceId: WORKSPACE, scope: scopeOf('chat', 'conv-victim') }, d),
    ).toBe(false);
  });

  it('REFUSES a conversation that does not exist — no existence oracle either', async () => {
    const d = deps({ findConversation: vi.fn(async () => null) });
    expect(
      await authorizePaneScope({ viewerId: VIEWER, workspaceId: WORKSPACE, scope: scopeOf('chat', 'made-up') }, d),
    ).toBe(false);
  });

  it('allows a conversation already bound to THIS workspace', async () => {
    const d = deps({ findConversation: vi.fn(async () => conversation({ workspaceId: WORKSPACE })) });
    expect(
      await authorizePaneScope({ viewerId: VIEWER, workspaceId: WORKSPACE, scope: scopeOf('chat', 'conv-here') }, d),
    ).toBe(true);
  });

  it("allows the caller's OWN conversation from anywhere", async () => {
    const d = deps({ findConversation: vi.fn(async () => conversation({ userId: VIEWER })) });
    expect(
      await authorizePaneScope({ viewerId: VIEWER, workspaceId: WORKSPACE, scope: scopeOf('chat', 'conv-mine') }, d),
    ).toBe(true);
  });

  it('allows a shared page conversation whose page the caller can view', async () => {
    const d = deps({
      findConversation: vi.fn(async () => conversation({ isShared: true, type: 'page', contextId: 'page-1' })),
      canViewPage: vi.fn(async () => true),
    });
    expect(
      await authorizePaneScope({ viewerId: VIEWER, workspaceId: WORKSPACE, scope: scopeOf('chat', 'conv-shared') }, d),
    ).toBe(true);
  });

  it('REFUSES a shared page conversation whose page the caller CANNOT view', async () => {
    const d = deps({
      findConversation: vi.fn(async () => conversation({ isShared: true, type: 'page', contextId: 'page-1' })),
      canViewPage: vi.fn(async () => false),
    });
    expect(
      await authorizePaneScope({ viewerId: VIEWER, workspaceId: WORKSPACE, scope: scopeOf('chat', 'conv-shared') }, d),
    ).toBe(false);
  });
});

describe('an unbound picker pane', () => {
  it('needs no authority — there is no target yet', async () => {
    const d = deps();
    expect(
      await authorizePaneScope({ viewerId: VIEWER, workspaceId: WORKSPACE, scope: scopeOf('chat', null) }, d),
    ).toBe(true);
    expect(d.findConversation).not.toHaveBeenCalled();
  });
});
