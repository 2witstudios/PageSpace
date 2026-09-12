/**
 * `rename_workspace` — naming the CONTAINER, and who may.
 *
 * An agent could already label every individual thing it created — a worker
 * (`spawn_session`'s `name`), a shell tab (`spawn_shell`), a page pane
 * (`open_page_pane`'s `title`) — and could not name the workspace holding all
 * of them. Worse, a workspace an agent MINTED (`workspace: 'new'`) was created
 * with no name at all, so it sat in its owner's sidebar as the literal
 * fallback "Session", permanently, because nothing could rename it either.
 *
 * Two things are therefore under test here, and the second is the load-bearing
 * one:
 *
 * 1. The verb works, on the caller's own workspace and on one addressed by id.
 * 2. **Every refusal is the SAME refusal.** A workspace owned by someone else,
 *    one outside the calling credential's drives, and one that never existed
 *    must be indistinguishable — otherwise the refusals themselves become a
 *    way to enumerate which workspace ids are real. That is the anti-
 *    enumeration rule the worker verbs already follow (`notYourSession`), and
 *    a rename is the newest place it could have been broken.
 *
 * The ownership and scope decisions live in the RUNTIME dep (they need the
 * workspace row), so what this suite pins at the factory level is that the
 * tool routes to that dep with the right target and ceiling, and reports its
 * one refusal faithfully. `session-tools-runtime.test.ts` covers the dep.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Tool } from 'ai';
import { createSessionTools, type SessionToolsDeps } from '../session-tools';
import type { ToolExecutionContext } from '../../core/types';
import { assert } from './riteway';

const OWNER = 'user-owner';
const OWN_WORKSPACE = 'ws-own';
const OTHER_WORKSPACE = 'ws-other';
const CONVERSATION = 'conv-caller';

function makeDeps(over: Partial<SessionToolsDeps> = {}): SessionToolsDeps {
  return {
    findOwnWorkspace: vi.fn(async () => ({ workspaceId: OWN_WORKSPACE, driveId: null, name: 'Old name' })),
    checkWorkspaceAccess: vi.fn(async () => ({ allowed: true })),
    checkWorkspaceEndAccess: vi.fn(async () => ({ allowed: true })),
    // The default stands in for the real runtime's owner-and-scope check
    // having PASSED; the refusal cases below override it, exactly as the
    // runtime would answer.
    renameWorkspace: vi.fn(async ({ name }: { name: string }) => ({ ok: true as const, name })),
    listWorkspaceWorkers: vi.fn(async () => ({ sandbox: 'none' as const, workers: [], shells: [] })),
    listOwnWorkspaces: vi.fn(async () => []),
    listSharedWorkspaces: vi.fn(async () => []),
    findWorker: vi.fn(async () => null),
    countOpenConversations: vi.fn(async () => 0),
    canUseAgent: vi.fn(async () => true),
    describeAgentToolSurface: vi.fn(async () => ({ configured: null, granted: [], blocked: [], conditional: [], deferred: [], notes: [] })),
    describeWorkerComputeShortfall: vi.fn(async () => null),
    createWorkerSession: vi.fn(async () => ({ ok: true as const, workspaceId: OWN_WORKSPACE })),
    dispatch: vi.fn(async () => ({ ok: true as const, waited: false as const })),
    readTranscript: vi.fn(async () => []),
    killWorker: vi.fn(async () => ({ ok: true as const, spriteTornDown: false })),
    ensureOwnSessionSandbox: vi.fn(async () => ({ ok: true as const })),
    spawnShell: vi.fn(async () => ({ ok: false as const, reason: 'sandbox_unavailable' as const })),
    findShell: vi.fn(async () => null),
    killShell: vi.fn(async () => ({ ok: true as const, killed: true, panes: { paneCount: 1, nodeId: 'pane-1' } })),
    shellIo: {
      read: vi.fn(async () => ({ ok: true as const, live: true, hasOutput: false, output: '' })),
      send: vi.fn(async () => ({ ok: true as const, delivered: true as const })),
    },
    readPaneGrid: vi.fn(async () => null),
    applyLayoutCommand: vi.fn(async () => ({ ok: true as const, changed: true })),
    newId: vi.fn(() => 'minted-id'),
    ...over,
  };
}

function runWith(
  deps: SessionToolsDeps,
  input: unknown,
  context: Partial<ToolExecutionContext> = {},
): Promise<Record<string, unknown>> {
  const tool = createSessionTools(deps).rename_workspace as Tool;
  const execute = tool.execute as (input: unknown, options: unknown) => Promise<Record<string, unknown>>;
  return execute(input, {
    experimental_context: { userId: OWNER, conversationId: CONVERSATION, ...context } as ToolExecutionContext,
    toolCallId: 'call-1',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('rename_workspace: the workspace this conversation is in', () => {
  it('renames the caller\'s OWN workspace when no id is given', async () => {
    const deps = makeDeps();
    const result = await runWith(deps, { name: 'Deploy work' });

    assert({
      given: 'a rename with no workspaceId',
      should: 'resolve the conversation\'s own workspace and rename it',
      actual: { success: result.success, workspaceId: result.workspaceId, name: result.name },
      expected: { success: true, workspaceId: OWN_WORKSPACE, name: 'Deploy work' },
    });
    expect(deps.renameWorkspace).toHaveBeenCalledWith({
      userId: OWNER,
      workspaceId: OWN_WORKSPACE,
      name: 'Deploy work',
      allowedDriveIds: [],
    });
  });

  it('reports the STORED name rather than echoing the requested one', async () => {
    // The boundary trims; echoing the input could show the user one thing and
    // the model another.
    const deps = makeDeps({
      renameWorkspace: vi.fn(async () => ({ ok: true as const, name: 'Trimmed' })),
    });
    const result = await runWith(deps, { name: '  Trimmed  ' });

    assert({
      given: 'a server that stored a normalised name',
      should: 'return what was stored',
      actual: result.name,
      expected: 'Trimmed',
    });
  });

  it('trims the name before it reaches the runtime', async () => {
    // The HTTP boundary normalises through `sessionNameSchema`; this tool
    // reaches the runtime directly, so it must do the same or a padded label
    // gets stored.
    const deps = makeDeps();
    await runWith(deps, { name: '  Deploy work  ' });

    expect(deps.renameWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Deploy work' }),
    );
  });

  it('refuses a whitespace-only name without attempting a write', async () => {
    // Would otherwise be stored as a blank — the nameless state this whole
    // surface exists to remove.
    const deps = makeDeps();
    const result = await runWith(deps, { name: '     ' });

    assert({
      given: 'a name that is only whitespace',
      should: 'refuse and write nothing',
      actual: result.success,
      expected: false,
    });
    expect(deps.renameWorkspace).not.toHaveBeenCalled();
  });

  it('refuses when the conversation has no workspace at all', async () => {
    const deps = makeDeps({ findOwnWorkspace: vi.fn(async () => null) });
    const result = await runWith(deps, { name: 'Deploy work' });

    assert({
      given: 'a plain conversation with no workspace',
      should: 'refuse without attempting a write',
      actual: result.success,
      expected: false,
    });
    expect(deps.renameWorkspace).not.toHaveBeenCalled();
  });

  it('refuses without an authenticated actor', async () => {
    const deps = makeDeps();
    const result = await runWith(deps, { name: 'Deploy work' }, { userId: undefined as unknown as string });

    assert({
      given: 'no authenticated user',
      should: 'refuse without attempting a write',
      actual: result.success,
      expected: false,
    });
    expect(deps.renameWorkspace).not.toHaveBeenCalled();
  });
});

describe('rename_workspace: a workspace addressed by id', () => {
  it('renames another workspace the caller owns, without resolving its own binding', async () => {
    const deps = makeDeps();
    const result = await runWith(deps, { name: 'Fan-out 2', workspaceId: OTHER_WORKSPACE });

    assert({
      given: 'an explicit workspaceId',
      should: 'rename THAT workspace',
      actual: { success: result.success, workspaceId: result.workspaceId },
      expected: { success: true, workspaceId: OTHER_WORKSPACE },
    });
    // The whole reason the parameter exists: an orchestrator that spawned five
    // fresh workspaces must be able to label them without standing in each.
    expect(deps.findOwnWorkspace).not.toHaveBeenCalled();
  });

  it('carries the calling credential\'s drive ceiling to the runtime', async () => {
    // A rename is a WRITE, so a drive-scoped token must not reach outside its
    // drives — the same argument that gates spawn placement. The tool's job is
    // to pass the ceiling; the runtime compares it to the workspace's drive.
    const deps = makeDeps();
    await runWith(deps, { name: 'Scoped', workspaceId: OTHER_WORKSPACE }, { mcpAllowedDriveIds: ['drive-a'] });

    expect(deps.renameWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ allowedDriveIds: ['drive-a'] }),
    );
  });
});

describe('rename_workspace: every refusal reads the same (anti-enumeration)', () => {
  const refusal = async () => {
    const deps = makeDeps({
      renameWorkspace: vi.fn(async () => ({ ok: false as const, reason: 'not_found_or_denied' as const })),
    });
    return runWith(deps, { name: 'Anything', workspaceId: OTHER_WORKSPACE });
  };

  it('refuses a workspace that is not the caller\'s, does not exist, or is out of scope — identically', async () => {
    // One dep answer covers all three causes BY CONSTRUCTION: the runtime
    // collapses them to a single reason, so there is no branch here that could
    // later grow a distinguishing message.
    const first = await refusal();
    const second = await refusal();

    assert({
      given: 'a refused rename',
      should: 'fail without leaking why',
      actual: { success: first.success, sameMessage: first.error === second.error },
      expected: { success: false, sameMessage: true },
    });
  });

  it('names the id the caller asked for, and nothing about its existence', async () => {
    const result = await refusal();

    assert({
      given: 'a refused rename of an explicit id',
      should: 'echo only the id the caller already knew',
      actual: typeof result.error === 'string' && (result.error as string).includes(OTHER_WORKSPACE),
      expected: true,
    });
  });
});
