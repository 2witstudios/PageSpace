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

  /**
   * Resolution SUCCEEDED, the write was refused — a different thing from
   * having no workspace, and the refusal must say so.
   *
   * Reachable whenever the conversation is bound to a workspace the caller may
   * use but not relabel: a worker spawned into a colleague's shared workspace,
   * or a drive-scoped credential whose ceiling excludes that workspace's drive.
   * The first cut reported the no-workspace-at-all arm here, which told the
   * model something false AND pointed it at spawn_session — a spurious
   * workspace against its owner's cap, for a conversation that already has one.
   */
  it('given a resolved own workspace whose rename is refused, does NOT claim there is no workspace', async () => {
    const deps = makeDeps({
      renameWorkspace: vi.fn(async () => ({ ok: false as const, reason: 'not_found_or_denied' as const })),
    });
    const result = await runWith(deps, { name: 'Deploy work' });

    const error = String(result.error);
    assert({
      given: 'a refused rename of the conversation\'s own workspace',
      should: 'name the workspace it could not rename rather than denying one exists',
      actual: { success: result.success, mentionsId: error.includes(OWN_WORKSPACE) },
      expected: { success: false, mentionsId: true },
    });
    // The harmful half: never send the model to spawn a workspace it has.
    expect(error).not.toContain('spawn_session');
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

describe('rename_workspace: a refusal names nothing the caller did not already supply', () => {
  /**
   * The anti-enumeration property itself lives one layer down, in the runtime
   * dep, because that is where the three causes (no such row / not yours / out
   * of credential scope) are distinguishable at all — and it is asserted there,
   * against genuinely different inputs, by `session-tools-runtime.test.ts`'s
   * "every refusal is the same refusal".
   *
   * What is testable HERE is the tool's half of the bargain: it receives one
   * opaque reason and must not embellish it. An earlier version of this suite
   * called the same mock twice and compared the two strings, which is true
   * however the tool behaves — the distinguishing input never reached it. That
   * proved nothing and is gone.
   */
  it('renders the single opaque reason without adding a cause', async () => {
    const deps = makeDeps({
      renameWorkspace: vi.fn(async () => ({ ok: false as const, reason: 'not_found_or_denied' as const })),
    });
    const result = await runWith(deps, { name: 'Anything', workspaceId: OTHER_WORKSPACE });

    const error = String(result.error);
    assert({
      given: 'the runtime\'s one refusal reason',
      should: 'fail without naming a cause',
      actual: {
        success: result.success,
        // The id the caller passed in is the only identifier it may echo.
        echoesCallerId: error.includes(OTHER_WORKSPACE),
      },
      expected: { success: false, echoesCallerId: true },
    });
    for (const leak of ['owner', 'owned by', 'belongs to', 'scope', 'credential', 'permission', 'drive']) {
      expect(error.toLowerCase(), `refusal must not hint at "${leak}"`).not.toContain(leak);
    }
  });

  it('passes the model-supplied id through unchanged and invents no other', async () => {
    const deps = makeDeps({
      renameWorkspace: vi.fn(async () => ({ ok: false as const, reason: 'not_found_or_denied' as const })),
    });
    const result = await runWith(deps, { name: 'Anything', workspaceId: OTHER_WORKSPACE });

    expect(String(result.error)).not.toContain(OWN_WORKSPACE);
  });
});
