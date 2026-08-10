/**
 * THE MEMBERSHIP CHOKEPOINT — a conversation and the node that makes it a
 * member of a workspace, in ONE transaction.
 *
 * The property this suite exists for is the ghost: a conversation row that
 * landed while its membership did not. It is held down structurally rather than
 * by assertion order — every creator here runs inside `within`, the callback the
 * membership write hands its transaction to, so a test can prove the creators
 * were never reachable except through it.
 *
 * Three claims, each with its own group:
 *
 *  1. **The creators only ever run inside the transaction.** Not "were called
 *     after" — `admitConversation` is the only thing that can call them at all,
 *     because it is the only thing holding `within`.
 *  2. **A creator that throws writes no membership.** The refusal unwinds; the
 *     fake `admitConversation` below models the rollback by never reporting a
 *     success it did not complete.
 *  3. **The gates that run BEFORE the transaction refuse without opening one.**
 *     A doomed mint must not take the workspace's lock, and must certainly not
 *     leave a conversation behind.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  AgentNotInSessionDriveError,
  ConversationUnavailableError,
  SessionFullError,
  createConversationInSessionWith,
  type CreateConversationInSessionDeps,
} from '../create-conversation-in-workspace';
import type { AdmitConversationOutcome } from '../claim-conversation-in-workspace';

/** The transaction handle. Opaque to the module under test, which is the point. */
const TX = { tx: true };

interface MockDeps extends CreateConversationInSessionDeps<typeof TX> {
  createPageConversation: ReturnType<typeof vi.fn>;
  createGlobalConversation: ReturnType<typeof vi.fn>;
  findConversation: ReturnType<typeof vi.fn>;
  findConversationIn: ReturnType<typeof vi.fn>;
  findWorkspaceOfConversation: ReturnType<typeof vi.fn>;
  findAgentDriveId: ReturnType<typeof vi.fn>;
  findSession: ReturnType<typeof vi.fn>;
  admitConversation: ReturnType<typeof vi.fn>;
}

const OWNER = 'user-1';
const WORKSPACE = 'ws-1';
const AGENT = 'agent-1';

/**
 * A fake membership write that behaves like the real transaction: it runs
 * `within`, and if `within` throws it reports NOTHING — no outcome, no
 * membership — exactly as a rollback does.
 */
function fakeAdmit(outcome: AdmitConversationOutcome = 'admitted') {
  return vi.fn(async (request: { within?: (tx: typeof TX) => Promise<void> }) => {
    if (request.within) await request.within(TX);
    return outcome;
  });
}

function makeDeps(overrides: Partial<Record<keyof MockDeps, unknown>> = {}): MockDeps {
  return {
    createPageConversation: vi.fn(async () => 'created' as const),
    createGlobalConversation: vi.fn(async () => undefined),
    findConversation: vi.fn(async () => null),
    findConversationIn: vi.fn(async () => ({ userId: OWNER, type: 'page', contextId: AGENT })),
    findWorkspaceOfConversation: vi.fn(async () => null),
    findAgentDriveId: vi.fn(async () => 'drive-1'),
    findSession: vi.fn(async () => ({ driveId: 'drive-1', endedAt: null })),
    admitConversation: fakeAdmit(),
    ...overrides,
  } as MockDeps;
}

const input = {
  conversationId: 'conv-1',
  userId: OWNER,
  agentPageId: AGENT,
  workspaceId: WORKSPACE,
};

describe('the conversation and its membership are one transaction', () => {
  let deps: MockDeps;
  beforeEach(() => {
    deps = makeDeps();
  });

  it('creates the row on the TRANSACTION the membership write supplied', async () => {
    await createConversationInSessionWith(deps, input);

    expect(deps.createPageConversation).toHaveBeenCalledWith(
      { conversationId: 'conv-1', userId: OWNER, agentPageId: AGENT, title: null },
      TX,
    );
  });

  it('creates a GLOBAL thread on that same transaction', async () => {
    await createConversationInSessionWith(deps, { ...input, agentPageId: null, title: 'Worker' });

    expect(deps.createGlobalConversation).toHaveBeenCalledWith(
      { conversationId: 'conv-1', userId: OWNER, title: 'Worker' },
      TX,
    );
    expect(deps.createPageConversation).not.toHaveBeenCalled();
  });

  it('runs NO creator outside the membership write', async () => {
    // Structural, not ordering: the only reference to `within` is the one the
    // membership write holds, so a creator running at all means the transaction
    // was open. Refusing to admit therefore refuses to create.
    deps.admitConversation = vi.fn(async () => 'refused' as const);

    await expect(createConversationInSessionWith(deps, input)).rejects.toBeInstanceOf(
      ConversationUnavailableError,
    );
    expect(deps.createPageConversation).not.toHaveBeenCalled();
  });

  it('a creator that throws takes the membership with it', async () => {
    deps.createGlobalConversation.mockRejectedValue(new Error('owned by someone else'));

    await expect(
      createConversationInSessionWith(deps, { ...input, agentPageId: null }),
    ).rejects.toBeInstanceOf(ConversationUnavailableError);
    // The fake models a rollback: `within` threw, so the write reported nothing.
    expect(deps.admitConversation).toHaveBeenCalledTimes(1);
  });

  it('passes the spawning conversation through, so a spawn never evicts its own invoker', async () => {
    await createConversationInSessionWith(deps, { ...input, excludeTargetId: 'conv-caller' });

    expect(deps.admitConversation).toHaveBeenCalledWith(
      expect.objectContaining({ excludeTargetId: 'conv-caller' }),
    );
  });

  it('passes NO placement flag — every admission is placed, by one policy', async () => {
    // `attach: false` was the default and meant PARKED: the picker mints its own
    // unbound pane, so an attached admission would have placed a SECOND one
    // beside it. The placement policy only ever FILLS an unbound pane before it
    // splits, so the picker's waiting pane is exactly what it lands in — the
    // trap the flag existed to dodge is not reachable.
    await createConversationInSessionWith(deps, input);
    const [[passed]] = deps.admitConversation.mock.calls;
    expect(passed).not.toHaveProperty('attach');
  });
});

describe('the gates that refuse before a transaction is opened', () => {
  let deps: MockDeps;
  beforeEach(() => {
    deps = makeDeps();
  });

  it('refuses when the workspace does not exist', async () => {
    deps.findSession.mockResolvedValue(null);

    await expect(createConversationInSessionWith(deps, input)).rejects.toBeInstanceOf(
      ConversationUnavailableError,
    );
    expect(deps.admitConversation).not.toHaveBeenCalled();
    expect(deps.createPageConversation).not.toHaveBeenCalled();
  });

  it('admits into an ENDED workspace — lifecycle state never refuses a permitted create', async () => {
    deps.findSession.mockResolvedValue({ driveId: 'drive-1', endedAt: new Date() });
    await expect(createConversationInSessionWith(deps, input)).resolves.toBeUndefined();
  });

  it('refuses an agent from another DRIVE', async () => {
    deps.findAgentDriveId.mockResolvedValue('drive-2');

    await expect(createConversationInSessionWith(deps, input)).rejects.toBeInstanceOf(
      AgentNotInSessionDriveError,
    );
    expect(deps.admitConversation).not.toHaveBeenCalled();
  });

  it('refuses a missing or trashed agent, fail-closed', async () => {
    deps.findAgentDriveId.mockResolvedValue(null);

    await expect(createConversationInSessionWith(deps, input)).rejects.toBeInstanceOf(
      ConversationUnavailableError,
    );
    expect(deps.admitConversation).not.toHaveBeenCalled();
  });

  it('exempts a GLOBAL workspace from the cross-drive rule', async () => {
    deps.findSession.mockResolvedValue({ driveId: null, endedAt: null });
    deps.findAgentDriveId.mockResolvedValue('drive-9');

    await expect(createConversationInSessionWith(deps, input)).resolves.toBeUndefined();
  });

  it('needs no agent lookup for a global thread', async () => {
    await createConversationInSessionWith(deps, { ...input, agentPageId: null });
    expect(deps.findAgentDriveId).not.toHaveBeenCalled();
  });
});

describe('an id that already resolves to something', () => {
  let deps: MockDeps;
  beforeEach(() => {
    deps = makeDeps();
  });

  it('accepts a retry of the caller\'s OWN thread with the SAME agent', async () => {
    deps.createPageConversation.mockResolvedValue('exists');
    await expect(createConversationInSessionWith(deps, input)).resolves.toBeUndefined();
    // Read on the transaction, so a row this transaction just inserted — or one
    // a concurrent insert won the squat race with — is visible to its own check.
    expect(deps.findConversationIn).toHaveBeenCalledWith('conv-1', TX);
  });

  it('refuses an id anchored to a DIFFERENT agent', async () => {
    deps.createPageConversation.mockResolvedValue('exists');
    deps.findConversationIn.mockResolvedValue({ userId: OWNER, type: 'page', contextId: 'agent-other' });

    await expect(createConversationInSessionWith(deps, input)).rejects.toBeInstanceOf(
      ConversationUnavailableError,
    );
  });

  it('refuses an id that resolves to SOMEONE ELSE\'S thread', async () => {
    // The gate the old shape got by composing on top of the claim primitive,
    // which read the row and refused a foreign owner. The composition is gone;
    // the gate is not.
    deps.createPageConversation.mockResolvedValue('exists');
    deps.findConversationIn.mockResolvedValue({ userId: 'user-2', type: 'page', contextId: AGENT });

    await expect(createConversationInSessionWith(deps, input)).rejects.toBeInstanceOf(
      ConversationUnavailableError,
    );
  });

  it('refuses an id that resolves to a GLOBAL thread when a page one was asked for', async () => {
    deps.createPageConversation.mockResolvedValue('exists');
    deps.findConversationIn.mockResolvedValue({ userId: OWNER, type: 'global', contextId: null });

    await expect(createConversationInSessionWith(deps, input)).rejects.toBeInstanceOf(
      ConversationUnavailableError,
    );
  });

  it('refuses an id whose messages belong to someone else', async () => {
    deps.createPageConversation.mockResolvedValue('message_owner_conflict');

    await expect(createConversationInSessionWith(deps, input)).rejects.toBeInstanceOf(
      ConversationUnavailableError,
    );
  });
});

describe('what the membership write answers', () => {
  let deps: MockDeps;
  beforeEach(() => {
    deps = makeDeps();
  });

  it('a thread the workspace already holds is a success, not an error', async () => {
    deps.admitConversation = fakeAdmit('already_a_member');
    await expect(createConversationInSessionWith(deps, input)).resolves.toBeUndefined();
  });

  it('surfaces the cap the TREE enforced', async () => {
    deps.admitConversation = fakeAdmit('session_full');
    await expect(createConversationInSessionWith(deps, input)).rejects.toBeInstanceOf(SessionFullError);
  });

  it('collapses the chat-target INDEX\'s refusal into the generic unavailability', async () => {
    // Two workspaces raced for one conversation and the database settled it.
    // The caller learns nothing more than "not available" — the reason rides
    // along as `cause` for the boundary's log.
    deps.admitConversation = fakeAdmit('bound_elsewhere');
    const error = await createConversationInSessionWith(deps, input).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ConversationUnavailableError);
    expect((error as ConversationUnavailableError).message).toBe('conversation_unavailable');
    expect(((error as ConversationUnavailableError).cause as Error).message).toBe('admit_bound_elsewhere');
  });
});
