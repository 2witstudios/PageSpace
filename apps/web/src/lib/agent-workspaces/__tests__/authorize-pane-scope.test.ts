// @vitest-environment node
/**
 * BINDING A PANE IS A PERMISSION DECISION (security review HIGH 1, attack B).
 *
 * A write payload carries a free `targetId` + `kind`. A route that validated
 * session access ONLY — never the target — would let anyone with a workspace of
 * their own bind an arbitrary conversation, shell, or page id and read the
 * resolved title back out of the response. This is the write half of that fix (the read half is
 * the label resolution in `workspace-node-runtime.ts`); belt and braces,
 * because the row a bad bind leaves behind outlives the request that made it.
 */
import { describe, it, expect, vi } from 'vitest';
import { authorizePaneScope, type PaneScopeAuthorityDeps } from '../authorize-pane-scope';

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
  targetId,
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
