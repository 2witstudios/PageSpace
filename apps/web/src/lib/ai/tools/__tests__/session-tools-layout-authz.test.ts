/**
 * THE LAYOUT TOOLS RUN THE SESSION-ACCESS CHECK (security review HIGH 2).
 *
 * `openOwnGrid`'s docblock claimed "the runtime re-runs `checkSessionAccess`
 * anyway on the way in, so the gate is one function in one place for both
 * entry points." It did not. `openOwnGrid` resolved the caller's conversation
 * to its workspace and stopped; neither wired dep checked anything
 * (`readPaneGrid` → the layout snapshot, `applyLayoutCommand` → the layout
 * writer). `checkSessionAccess` was imported by the
 * runtime and used only by `resolveWorkerPlacement`.
 *
 * The attack the structural argument misses: a conversation→workspace binding
 * is PERMANENT by design, but drive membership is not. A member spawns a
 * worker into a shared workspace (legitimate), then loses access to the
 * drive. Every HTTP route 404s her afterwards — but the binding still
 * resolves, so `list_panes` kept returning the whole labelled grid and
 * `move_pane` / `resize_pane` / `arrange_panes` kept WRITING the victim's
 * grid and broadcasting into their live UI. The tool surface was wider than
 * the HTTP surface it claimed to mirror.
 *
 * The existing `session-tools-contract.test.ts` is single-workspace mocks
 * where the caller always has access, and structurally cannot see this — so
 * this suite carries a SECOND workspace and a REVOKED member.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Tool } from 'ai';
import { createSessionTools, type PaneGridListing, type SessionToolsDeps } from '../session-tools';
import type { ToolExecutionContext } from '../../core/types';

/** Alice's workspace. Mallory's worker conversation is bound into it. */
const ALICE_WORKSPACE = 'ws-alice';
const MALLORY = 'mallory';
const MALLORY_WORKER_CONVERSATION = 'conv-mallory-worker';

const LAYOUT: PaneGridListing = {
  nodes: [
    { nodeId: 'root', nodeType: 'root', parentId: null, position: 0, axis: 'row', kind: null, targetId: null, name: '', fraction: null },
    { nodeId: 'pane-1', nodeType: 'pane', parentId: 'root', position: 0, axis: null, kind: 'chat', targetId: 'conv-alice-private', name: 'Q3 layoffs plan', fraction: null },
  ],
};

function makeDeps(over: Partial<SessionToolsDeps> = {}): SessionToolsDeps {
  return {
    // The binding survives revocation — that is the whole point.
    findOwnWorkspace: vi.fn(async () => ({ workspaceId: ALICE_WORKSPACE, driveId: null })),
    // Mallory is no longer a member of the drive Alice's workspace lives in.
    checkWorkspaceAccess: vi.fn(async () => ({ allowed: false, reason: 'not_a_member' })),
    checkWorkspaceEndAccess: vi.fn(async () => ({ allowed: true })),
    listWorkspaceWorkers: vi.fn(async () => ({ sandbox: 'running' as const, workers: [], shells: [] })),
    listOwnWorkspaces: vi.fn(async () => []),
    listSharedWorkspaces: vi.fn(async () => []),
    findWorker: vi.fn(async () => null),
    countOpenConversations: vi.fn(async () => 0),
    canUseAgent: vi.fn(async () => true),
    describeAgentToolSurface: vi.fn(async () => ({ configured: null, granted: [], blocked: [], deferred: [], notes: [] })),
    createWorkerSession: vi.fn(async () => ({ ok: true as const, workspaceId: ALICE_WORKSPACE })),
    dispatch: vi.fn(async () => ({ ok: true as const, waited: false as const })),
    readTranscript: vi.fn(async () => []),
    killWorker: vi.fn(async () => ({ ok: true as const, spriteTornDown: false })),
    ensureOwnSessionSandbox: vi.fn(async () => ({ ok: true as const })),
    spawnShell: vi.fn(async () => ({ ok: false as const, reason: 'sandbox_unavailable' as const })),
    findShell: vi.fn(async () => null),
    killShell: vi.fn(async () => ({ ok: true as const, killed: true, panes: { paneCount: 2, nodeId: 'pane-shell' } })),
    shellIo: {
      read: vi.fn(async () => ({ ok: true as const, live: true, hasOutput: false, output: '' })),
      send: vi.fn(async () => ({ ok: true as const, delivered: true as const })),
    },
    readPaneGrid: vi.fn(async () => LAYOUT),
    applyLayoutCommand: vi.fn(async () => ({ ok: true as const, changed: true })),
    newId: vi.fn(() => 'minted-id'),
    ...over,
  };
}

const options = { experimental_context: { userId: MALLORY, conversationId: MALLORY_WORKER_CONVERSATION } as ToolExecutionContext, toolCallId: 'call-1' };

async function run(toolDef: Tool, input: unknown): Promise<Record<string, unknown>> {
  const execute = toolDef.execute as (input: unknown, options: unknown) => Promise<Record<string, unknown>>;
  return execute(input, options);
}

/** Every layout tool, with an input that would otherwise succeed. */
const LAYOUT_CALLS: Array<[string, unknown]> = [
  ['list_panes', {}],
  ['resize_pane', { nodeId: 'pane-1', size: 0.5 }],
  ['move_pane', { nodeId: 'pane-1', toParentId: 'root' }],
  ['arrange_panes', { nodeIds: ['pane-1'] }],
];

let deps: SessionToolsDeps;

beforeEach(() => {
  vi.clearAllMocks();
  deps = makeDeps();
});

describe('a revoked member whose worker is still bound into the victim\'s workspace', () => {
  for (const [toolName, input] of LAYOUT_CALLS) {
    it(`${toolName}: refuses, and never touches the grid`, async () => {
      const tools = createSessionTools(deps);
      const result = await run((tools as Record<string, Tool>)[toolName], input);

      expect(result.success, `${toolName} must refuse a revoked caller`).toBe(false);
      // The reads and the writes both stop at the gate.
      expect(deps.readPaneGrid).not.toHaveBeenCalled();
      expect(deps.applyLayoutCommand).not.toHaveBeenCalled();
      // Nothing about the victim's grid leaks into the refusal.
      expect(JSON.stringify(result)).not.toContain('Q3 layoffs plan');
      expect(JSON.stringify(result)).not.toContain('conv-alice-private');
    });
  }

  it('asks the ONE session-access decision, for the caller and the bound workspace', async () => {
    const tools = createSessionTools(deps);
    await run(tools.list_panes as Tool, {});
    expect(deps.checkWorkspaceAccess).toHaveBeenCalledWith(MALLORY, ALICE_WORKSPACE);
  });
});

describe('a caller who still has session access', () => {
  beforeEach(() => {
    deps = makeDeps({ checkWorkspaceAccess: vi.fn(async () => ({ allowed: true })) });
  });

  it('list_panes reads the layout, labelled for THAT viewer', async () => {
    const tools = createSessionTools(deps);
    const result = await run(tools.list_panes as Tool, {});
    expect(result.success).toBe(true);
    expect(result.nodes).toEqual(LAYOUT.nodes);
    // The label join is per-viewer (review HIGH 1) — the tool must say who is
    // reading, not just which workspace.
    expect(deps.readPaneGrid).toHaveBeenCalledWith(ALICE_WORKSPACE, MALLORY);
  });

  it('a rearrange reaches the single writer', async () => {
    const tools = createSessionTools(deps);
    const result = await run(tools.resize_pane as Tool, { nodeId: 'pane-1', size: 0.5 });
    expect(result.success).toBe(true);
    // And it carries the ACTING USER through, whose authority the write's
    // binding gate spends — never the model's word for who is asking.
    expect(deps.applyLayoutCommand).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: ALICE_WORKSPACE, actingUserId: MALLORY }),
    );
  });
});

describe('the gate is checked before anything else can answer', () => {
  it('an unbound conversation still refuses without asking about access', async () => {
    deps = makeDeps({ findOwnWorkspace: vi.fn(async () => null) });
    const tools = createSessionTools(deps);
    const result = await run(tools.list_panes as Tool, {});
    expect(result.success).toBe(false);
    expect(deps.checkWorkspaceAccess).not.toHaveBeenCalled();
  });
});

/**
 * The layout tools were only ONE of the entry points resolving the permanent
 * binding. `list_sessions` and the shell family resolved it the same way and
 * checked nothing, so the HIGH-2 fix closed a quarter of its own hole.
 *
 * `list_sessions` is the widest read in the file — every worker's sessionId
 * and agent binding, every SHELL's id and name, and the sandbox's live status
 * — and it is deliberately excluded from `SANDBOX_COMPUTE_TOOL_NAMES` as free
 * session surface, so no tier filter covers it either.
 *
 * The shell family is the widest WRITE: `shell-io.ts` says outright that it
 * authorizes nothing and relies on `openOwnShell` to have confined the
 * shellId, and the realtime side writes to the PTY before its own re-auth tick
 * runs. So this gate is the only thing between a revoked member and keystroke
 * injection into another tenant's live shell.
 */
describe('a revoked member reaching the session and shell verbs', () => {
  const ALICE_SHELL = { shellId: 'sh-alice', workspaceId: ALICE_WORKSPACE, name: 'deploy-prod' };

  beforeEach(() => {
    deps = makeDeps({ findShell: vi.fn(async () => ALICE_SHELL) });
  });

  it('list_sessions: no detail view, and no worker or shell ids leak', async () => {
    const tools = createSessionTools(deps);
    const result = await run(tools.list_sessions as Tool, {});

    expect(deps.checkWorkspaceAccess).toHaveBeenCalledWith(MALLORY, ALICE_WORKSPACE);
    // The expensive detail read never happens...
    expect(deps.listWorkspaceWorkers).not.toHaveBeenCalled();
    // ...and the answer collapses to the same shape as a conversation that
    // never had a workspace, so revoked and never-bound are indistinguishable.
    expect(result.workspaceId).toBeNull();
    expect(result.workers).toEqual([]);
    expect(result.shells).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(ALICE_WORKSPACE);
    expect(JSON.stringify(result)).not.toContain('deploy-prod');
  });

  /**
   * THE REFUSED WORKSPACE MUST NOT COME BACK ONE FIELD OVER (review finding —
   * MAJOR, and the reason this assertion exists at all).
   *
   * The test above asserts `not.toContain(ALICE_WORKSPACE)` while `makeDeps`
   * stubs `listOwnWorkspaces` to `[]` — so it passed on an EMPTY sibling list
   * rather than on a suppressed one, and could never have seen the bug. The
   * case that can is the one where the caller OWNS the workspace they were
   * just refused: `list_sessions` passed `workspace?.workspaceId` as the
   * exclusion, and `workspace` is null on exactly that denial, so nothing was
   * excluded and the refused workspace was re-listed under `otherWorkspaces`
   * — with its name, driveId, live sandbox status and every worker's
   * sessionId.
   *
   * Ownership does not survive revocation: `decideAgentSessionAccess` is
   * explicit that losing the drive loses its working contexts, owner included.
   */
  it('list_sessions: a refused workspace the caller OWNS is not re-listed under otherWorkspaces', async () => {
    deps = makeDeps({
      findShell: vi.fn(async () => ALICE_SHELL),
      // The caller owns the bound workspace — so the own-listing would return
      // it, and the exclusion is the only thing standing between the denial
      // and the data. The stub HONOURS `excludeWorkspaceId` rather than
      // ignoring it, because that is the dep's contract: a stub that returned
      // the row unconditionally would fail whatever the tool passed, and a
      // stub that returned `[]` (as `makeDeps` does) would pass whatever it
      // passed. Only one that filters can tell the two apart.
      listOwnWorkspaces: vi.fn(async ({ excludeWorkspaceId }) =>
        [
          {
            workspaceId: ALICE_WORKSPACE,
            name: 'deploy-prod-workspace',
            driveId: 'drive-alice',
            sandbox: 'running' as const,
            workers: [{ sessionId: 'conv-alice-private', name: 'Q3 layoffs plan', agent: null }],
          },
        ].filter((w) => w.workspaceId !== excludeWorkspaceId),
      ),
    });

    const tools = createSessionTools(deps);
    const result = await run(tools.list_sessions as Tool, {});

    // The exclusion is keyed on the BINDING, which survives the denial —
    // not on `workspace`, which the denial nulls.
    expect(deps.listOwnWorkspaces).toHaveBeenCalledWith({
      userId: MALLORY,
      excludeWorkspaceId: ALICE_WORKSPACE,
    });
    expect(deps.listSharedWorkspaces).toHaveBeenCalledWith({
      userId: MALLORY,
      excludeWorkspaceId: ALICE_WORKSPACE,
    });
    // And the payload is clean of everything that listing carries.
    expect(JSON.stringify(result)).not.toContain(ALICE_WORKSPACE);
    expect(JSON.stringify(result)).not.toContain('Q3 layoffs plan');
    expect(JSON.stringify(result)).not.toContain('drive-alice');
  });

  it('send_shell: refuses, and nothing is written to the PTY', async () => {
    const tools = createSessionTools(deps);
    // `keystrokes`, not `input` — `execute` is invoked directly here, so
    // nothing validates the payload against the input schema and a wrong field
    // name would still fail for the right reason while describing a call the
    // model can never make.
    const result = await run(tools.send_shell as Tool, { shellId: 'sh-alice', keystrokes: 'rm -rf /\n' });

    expect(result.success).toBe(false);
    expect(deps.shellIo.send).not.toHaveBeenCalled();
  });

  it('read_shell: refuses, and no scrollback is read', async () => {
    const tools = createSessionTools(deps);
    const result = await run(tools.read_shell as Tool, { shellId: 'sh-alice' });

    expect(result.success).toBe(false);
    expect(deps.shellIo.read).not.toHaveBeenCalled();
  });

  it('kill_shell: reports already-gone and never kills the victim\'s shell', async () => {
    const tools = createSessionTools(deps);
    const result = await run(tools.kill_shell as Tool, { shellId: 'sh-alice' });

    // Already-gone is this verb's fail-closed success shape (planKillTarget's
    // rule) — the refusal must not become a distinguishable error here.
    expect(result).toEqual(expect.objectContaining({ killed: false }));
    expect(deps.killShell).not.toHaveBeenCalled();
  });

  it('the shell verbs refuse a revoked caller the SAME way they refuse a foreign shell', async () => {
    const revoked = createSessionTools(deps);
    const revokedAnswer = await run(revoked.read_shell as Tool, { shellId: 'sh-alice' });

    // A caller who still has access, asking about a shell in someone else's
    // workspace, must get a byte-identical refusal — otherwise the difference
    // is an oracle for "does this shell exist in the workspace I lost".
    const foreign = createSessionTools(
      makeDeps({
        checkWorkspaceAccess: vi.fn(async () => ({ allowed: true })),
        findShell: vi.fn(async () => ({ ...ALICE_SHELL, workspaceId: 'ws-somewhere-else' })),
      }),
    );
    const foreignAnswer = await run(foreign.read_shell as Tool, { shellId: 'sh-alice' });

    expect(revokedAnswer).toEqual(foreignAnswer);
  });
});

describe('a caller who still has session access reaches the session and shell verbs', () => {
  it('list_sessions returns the detail view', async () => {
    const deps = makeDeps({ checkWorkspaceAccess: vi.fn(async () => ({ allowed: true })) });
    const tools = createSessionTools(deps);
    const result = await run(tools.list_sessions as Tool, {});

    expect(result.success).toBe(true);
    expect(result.workspaceId).toBe(ALICE_WORKSPACE);
    expect(deps.listWorkspaceWorkers).toHaveBeenCalled();
  });

  it('read_shell reaches the shell io', async () => {
    const deps = makeDeps({
      checkWorkspaceAccess: vi.fn(async () => ({ allowed: true })),
      findShell: vi.fn(async () => ({ shellId: 'sh-1', workspaceId: ALICE_WORKSPACE, name: 'sh' })),
    });
    const tools = createSessionTools(deps);
    const result = await run(tools.read_shell as Tool, { shellId: 'sh-1' });

    expect(result.success).toBe(true);
    expect(deps.shellIo.read).toHaveBeenCalled();
  });
});
