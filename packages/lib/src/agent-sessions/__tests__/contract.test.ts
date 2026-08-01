import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import {
  SANDBOX_STATUSES,
  sandboxStatusSchema,
  agentSessionDtoSchema,
  shellDtoSchema,
  shellConnectPayloadSchema,
  clampShellDimensions,
  MIN_COLS,
  MIN_ROWS,
  MAX_COLS,
  MAX_ROWS,
  SHELL_AGENT_TYPES,
  PANE_KINDS,
  paneScopeSchema,
  persistedPaneStateSchema,
  persistedColumnStateSchema,
  persistedWorkspaceStateSchema,
  shellReadPayloadSchema,
  shellSendPayloadSchema,
  MAX_SHELLS_PER_READ,
  MAX_SHELL_INPUT_BYTES,
  MAX_SCROLLBACK_TAIL_LINES,
} from '../contract';

const session = {
  sessionId: 'ses-1',
  driveId: 'drive-1',
  ownerId: 'user-1',
  name: 'Refactor the parser',
  sandboxStatus: 'running',
  createdAt: '2026-07-28T10:00:00.000Z',
  lastActiveAt: '2026-07-28T10:05:00.000Z',
  endedAt: null,
};

const shell = {
  shellId: 'shell-row-1',
  sessionId: 'ses-1',
  ownerId: 'user-1',
  name: 'shell-1',
  agentType: 'shell',
  command: null,
  createdAt: '2026-07-28T10:00:00.000Z',
};

describe('SandboxStatus', () => {
  it('should be exactly none | starting | running | ended', () => {
    expect(SANDBOX_STATUSES).toEqual(['none', 'starting', 'running', 'ended']);
  });

  it.each(SANDBOX_STATUSES)('given %s, should parse', (status) => {
    expect(sandboxStatusSchema.parse(status)).toBe(status);
  });

  it('given a status outside the four, should fail (no ad-hoc states)', () => {
    expect(sandboxStatusSchema.safeParse('stopped').success).toBe(false);
  });
});

describe('agentSessionDtoSchema', () => {
  it('given a well-formed session, should parse', () => {
    expect(agentSessionDtoSchema.parse(session)).toEqual(session);
  });

  it('given a null driveId (global-assistant session, user-scoped), should parse', () => {
    expect(agentSessionDtoSchema.parse({ ...session, driveId: null }).driveId).toBeNull();
  });

  it('given an empty sessionId, should fail (ids address — an empty one addresses nothing)', () => {
    const result = agentSessionDtoSchema.safeParse({ ...session, sessionId: '' });
    expect(result.success).toBe(false);
  });

  it('given a non-ISO lastActiveAt, should fail', () => {
    expect(agentSessionDtoSchema.safeParse({ ...session, lastActiveAt: 'yesterday' }).success).toBe(false);
  });

  it('given an ended session, should carry endedAt', () => {
    const parsed = agentSessionDtoSchema.parse({
      ...session,
      sandboxStatus: 'ended',
      endedAt: '2026-07-28T11:00:00.000Z',
    });
    expect(parsed.endedAt).toBe('2026-07-28T11:00:00.000Z');
  });

  it('should strip a conversation id — a session is not addressed by any thread', () => {
    // The inversion of the old rule: sessionId used to BE the conversation id.
    // A session hosts many conversations, so a conversationId on the session
    // DTO would be a claim about which thread "is" the session — a category
    // error the schema strips rather than models.
    const parsed = agentSessionDtoSchema.parse({ ...session, conversationId: 'conv-1' }) as Record<string, unknown>;
    expect(parsed.conversationId).toBeUndefined();
    expect(parsed.sessionId).toBe('ses-1');
  });

  it('should NOT accept an agent field — the agent belongs to each conversation, never the session', () => {
    const parsed = agentSessionDtoSchema.parse({ ...session, agentPageId: 'page-1' }) as Record<string, unknown>;
    expect(parsed.agentPageId).toBeUndefined();
  });
});

describe('shellDtoSchema', () => {
  it('given a well-formed shell, should parse', () => {
    expect(shellDtoSchema.parse(shell)).toEqual(shell);
  });

  it('should only accept PTY agent types', () => {
    expect(SHELL_AGENT_TYPES).toEqual(['shell']);
    expect(shellDtoSchema.safeParse({ ...shell, agentType: 'pagespace' }).success).toBe(false);
  });

  it('given a command override, should parse it', () => {
    expect(shellDtoSchema.parse({ ...shell, command: 'htop' }).command).toBe('htop');
  });

  it('given an empty shellId, should fail', () => {
    expect(shellDtoSchema.safeParse({ ...shell, shellId: '' }).success).toBe(false);
  });
});

describe('clampShellDimensions', () => {
  it('given dimensions in range, should pass them through floored', () => {
    expect(clampShellDimensions({ cols: 80.9, rows: 24.9 })).toEqual({ cols: 80, rows: 24 });
  });

  it('given oversized dimensions, should clamp to the maxima', () => {
    expect(clampShellDimensions({ cols: 100_000, rows: 100_000 })).toEqual({ cols: MAX_COLS, rows: MAX_ROWS });
  });

  it('given undersized dimensions, should clamp to the minima', () => {
    expect(clampShellDimensions({ cols: 1, rows: 1 })).toEqual({ cols: MIN_COLS, rows: MIN_ROWS });
  });
});

describe('shellConnectPayloadSchema', () => {
  it('given {shellId, cols, rows}, should parse and clamp', () => {
    expect(shellConnectPayloadSchema.parse({ shellId: 'shell-row-1', cols: 100_000, rows: 1 })).toEqual({
      shellId: 'shell-row-1',
      cols: MAX_COLS,
      rows: MIN_ROWS,
    });
  });

  it('given an optional connectionId, should keep it (one socket, several shells)', () => {
    expect(shellConnectPayloadSchema.parse({ shellId: 's1', cols: 80, rows: 24, connectionId: 'c1' })).toEqual({
      shellId: 's1',
      cols: 80,
      rows: 24,
      connectionId: 'c1',
    });
  });

  it('given an invalid connect payload, should fail with a typed ZodError naming the field', () => {
    const result = shellConnectPayloadSchema.safeParse({ cols: 80, rows: 24 });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected a parse failure');
    expect(result.error).toBeInstanceOf(ZodError);
    expect(result.error.issues[0]?.path).toEqual(['shellId']);
  });

  it('given an empty shellId, should fail', () => {
    expect(shellConnectPayloadSchema.safeParse({ shellId: '', cols: 80, rows: 24 }).success).toBe(false);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, '80'])(
    'given cols %p, should fail rather than clamp nonsense',
    (cols) => {
      expect(shellConnectPayloadSchema.safeParse({ shellId: 's1', cols, rows: 24 }).success).toBe(false);
    },
  );

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, '24'])('given rows %p, should fail', (rows) => {
    expect(shellConnectPayloadSchema.safeParse({ shellId: 's1', cols: 80, rows }).success).toBe(false);
  });

  it('given a non-object payload, should fail', () => {
    expect(shellConnectPayloadSchema.safeParse(null).success).toBe(false);
    expect(shellConnectPayloadSchema.safeParse('shell-1').success).toBe(false);
  });

  it('should strip a compound address — a shell is addressed by shellId alone', () => {
    const parsed = shellConnectPayloadSchema.parse({
      shellId: 's1',
      cols: 80,
      rows: 24,
      machineId: 'm1',
      projectName: 'p',
      branchName: 'b',
      sessionId: 'ses-1',
    }) as Record<string, unknown>;
    expect(parsed.machineId).toBeUndefined();
    expect(parsed.projectName).toBeUndefined();
    expect(parsed.branchName).toBeUndefined();
    expect(parsed.sessionId).toBeUndefined();
  });
});

describe('shellReadPayloadSchema', () => {
  it('given a single-shell read with a limit, should parse', () => {
    expect(shellReadPayloadSchema.parse({ shellIds: ['sh-1'], limit: 100 })).toEqual({
      shellIds: ['sh-1'],
      limit: 100,
    });
  });

  it('given the start half, should carry it — the semantics stay planSessionStart\'s decision', () => {
    expect(shellReadPayloadSchema.parse({ shellIds: ['sh-1'], start: true, userId: 'user-1' })).toEqual({
      shellIds: ['sh-1'],
      start: true,
      userId: 'user-1',
    });
  });

  it('given no shellIds, an empty list, or a blank id, should fail — ids address', () => {
    expect(shellReadPayloadSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(shellReadPayloadSchema.safeParse({ shellIds: [] }).success).toBe(false);
    expect(shellReadPayloadSchema.safeParse({ shellIds: [''] }).success).toBe(false);
  });

  it('given more shellIds than one listing can mean, should fail — a read is a session\'s listing, not a crawl', () => {
    const shellIds = Array.from({ length: MAX_SHELLS_PER_READ + 1 }, (_, index) => `sh-${index}`);
    expect(shellReadPayloadSchema.safeParse({ shellIds }).success).toBe(false);
    expect(shellReadPayloadSchema.safeParse({ shellIds: shellIds.slice(0, MAX_SHELLS_PER_READ) }).success).toBe(true);
  });

  it('given a negative, fractional, or unbounded limit, should fail — no unbounded number crosses this hop', () => {
    expect(shellReadPayloadSchema.safeParse({ shellIds: ['sh-1'], limit: -1 }).success).toBe(false);
    expect(shellReadPayloadSchema.safeParse({ shellIds: ['sh-1'], limit: 1.5 }).success).toBe(false);
    expect(shellReadPayloadSchema.safeParse({ shellIds: ['sh-1'], limit: MAX_SCROLLBACK_TAIL_LINES + 1 }).success).toBe(false);
    expect(shellReadPayloadSchema.safeParse({ shellIds: ['sh-1'], limit: 0 }).success).toBe(true);
  });

  it('given a non-boolean start or blank userId, should fail rather than coerce', () => {
    expect(shellReadPayloadSchema.safeParse({ shellIds: ['sh-1'], start: 'yes' }).success).toBe(false);
    expect(shellReadPayloadSchema.safeParse({ shellIds: ['sh-1'], userId: '' }).success).toBe(false);
  });
});

describe('shellSendPayloadSchema', () => {
  it('given a well-formed send, should parse', () => {
    expect(shellSendPayloadSchema.parse({ shellId: 'sh-1', input: 'ls\n' })).toEqual({
      shellId: 'sh-1',
      input: 'ls\n',
    });
  });

  it('given a missing or blank shellId, should fail', () => {
    expect(shellSendPayloadSchema.safeParse({ input: 'ls' }).success).toBe(false);
    expect(shellSendPayloadSchema.safeParse({ shellId: '', input: 'ls' }).success).toBe(false);
  });

  it('given an empty input, should fail — there is nothing to type', () => {
    expect(shellSendPayloadSchema.safeParse({ shellId: 'sh-1', input: '' }).success).toBe(false);
  });

  it('given input over the byte cap, should fail — refused, never truncated', () => {
    expect(
      shellSendPayloadSchema.safeParse({ shellId: 'sh-1', input: 'x'.repeat(MAX_SHELL_INPUT_BYTES + 1) }).success,
    ).toBe(false);
    expect(
      shellSendPayloadSchema.safeParse({ shellId: 'sh-1', input: 'x'.repeat(MAX_SHELL_INPUT_BYTES) }).success,
    ).toBe(true);
  });

  it('should count the cap in BYTES, not code units — what the PTY receives is bytes', () => {
    // '€' is 3 UTF-8 bytes: 1366 of them fit in 4096 code units but not 4096 bytes.
    expect(
      shellSendPayloadSchema.safeParse({ shellId: 'sh-1', input: '€'.repeat(1366) }).success,
    ).toBe(false);
  });
});

describe('paneScopeSchema', () => {
  it('should offer every surface — a pane that can only be a terminal makes panes pointless', () => {
    // The regression this guards: `SHELL_AGENT_TYPES` being PTY-only was read as
    // "the whole pane surface is PTY-only", which removed the ability to open an
    // agent conversation in a pane and left splitting with nothing to split into.
    // `'page'` extends this the same way: a page pane addresses an existing
    // PageSpace page directly, so a pane surface still isn't just PTY-only.
    expect([...PANE_KINDS].sort()).toEqual(['chat', 'page', 'terminal']);
  });

  it('should bind a chat pane to a conversation and its agent', () => {
    const parsed = paneScopeSchema.parse({
      kind: 'chat',
      name: 'Planning',
      targetId: 'conv-1',
      agentPageId: 'page-1',
    });
    expect(parsed).toEqual({ kind: 'chat', name: 'Planning', targetId: 'conv-1', agentPageId: 'page-1' });
  });

  it('should allow a null agentPageId — a global-assistant conversation has no agent page', () => {
    expect(
      paneScopeSchema.safeParse({ kind: 'chat', name: 'Assistant', targetId: 'conv-2', agentPageId: null }).success,
    ).toBe(true);
  });

  it('should let two panes name different agents, so one grid holds several side by side', () => {
    const left = paneScopeSchema.parse({ kind: 'chat', name: 'A', targetId: 'conv-a', agentPageId: 'agent-a' });
    const right = paneScopeSchema.parse({ kind: 'chat', name: 'B', targetId: 'conv-b', agentPageId: 'agent-b' });
    expect(left.agentPageId).not.toBe(right.agentPageId);
  });

  it('should accept a null targetId — the picker chose a kind before the row exists', () => {
    expect(
      paneScopeSchema.safeParse({ kind: 'terminal', name: 'shell-1', targetId: null, agentPageId: null }).success,
    ).toBe(true);
  });

  it('should reject an empty targetId — absent is a state, blank is a bug', () => {
    expect(
      paneScopeSchema.safeParse({ kind: 'terminal', name: 'shell-1', targetId: '', agentPageId: null }).success,
    ).toBe(false);
  });

  it('should reject an unknown kind', () => {
    expect(
      paneScopeSchema.safeParse({ kind: 'pagespace', name: 'x', targetId: 'c1', agentPageId: null }).success,
    ).toBe(false);
  });
});

const chatScope = (targetId: string, agentPageId: string | null = null) =>
  paneScopeSchema.parse({ kind: 'chat', name: 'Conversation', targetId, agentPageId });

describe('persistedPaneStateSchema', () => {
  it('should default tabs to an empty array — a terminal/page/picker pane never tabs', () => {
    const parsed = persistedPaneStateSchema.parse({ id: 'pane-1', scope: null });
    expect(parsed.tabs).toEqual([]);
  });

  it('given a pre-tabs chat pane (scope set, tabs missing entirely), should backfill tabs from scope', () => {
    const active = chatScope('conv-1', 'agent-a');
    const parsed = persistedPaneStateSchema.parse({ id: 'pane-1', scope: active });
    expect(parsed.tabs).toEqual([active]);
  });

  it('given a chat pane with an explicit empty tabs array, should still backfill from scope', () => {
    const active = chatScope('conv-1', 'agent-a');
    const parsed = persistedPaneStateSchema.parse({ id: 'pane-1', scope: active, tabs: [] });
    expect(parsed.tabs).toEqual([active]);
  });

  it('should carry every open tab, including the active one', () => {
    const active = chatScope('conv-1', 'agent-a');
    const background = chatScope('conv-2', 'agent-b');
    const parsed = persistedPaneStateSchema.parse({ id: 'pane-1', scope: active, tabs: [active, background] });
    expect(parsed.tabs).toEqual([active, background]);
    expect(parsed.scope).toEqual(active);
  });

  it('should reject a tab that fails paneScopeSchema — no half-shaped tab crosses the boundary', () => {
    const result = persistedPaneStateSchema.safeParse({
      id: 'pane-1',
      scope: null,
      tabs: [{ kind: 'chat', name: 'x', targetId: '', agentPageId: null }],
    });
    expect(result.success).toBe(false);
  });

  it('should reject an empty pane id', () => {
    expect(persistedPaneStateSchema.safeParse({ id: '', scope: null }).success).toBe(false);
  });
});

describe('persistedColumnStateSchema', () => {
  it('should require at least one pane — a column is never empty', () => {
    expect(persistedColumnStateSchema.safeParse({ id: 'col-1', panes: [] }).success).toBe(false);
  });

  it('should parse a column with panes', () => {
    const parsed = persistedColumnStateSchema.parse({
      id: 'col-1',
      panes: [{ id: 'pane-1', scope: null, tabs: [] }],
    });
    expect(parsed.panes).toHaveLength(1);
  });
});

describe('persistedWorkspaceStateSchema', () => {
  const workspace = {
    id: 'ses-1',
    columns: [{ id: 'col-1', panes: [{ id: 'pane-1', scope: chatScope('conv-1'), tabs: [chatScope('conv-1')] }] }],
    activePaneId: 'pane-1',
    pendingPickerPaneId: null,
  };

  it('given a well-formed grid, should parse', () => {
    expect(persistedWorkspaceStateSchema.parse(workspace)).toEqual(workspace);
  });

  it('should require at least one column — a grid is never empty', () => {
    expect(persistedWorkspaceStateSchema.safeParse({ ...workspace, columns: [] }).success).toBe(false);
  });

  it('should allow a null pendingPickerPaneId', () => {
    expect(persistedWorkspaceStateSchema.parse(workspace).pendingPickerPaneId).toBeNull();
  });

  it('should reject an empty activePaneId', () => {
    expect(persistedWorkspaceStateSchema.safeParse({ ...workspace, activePaneId: '' }).success).toBe(false);
  });

  it('should reject an empty-string pendingPickerPaneId — same non-empty rule as every other pane id', () => {
    expect(persistedWorkspaceStateSchema.safeParse({ ...workspace, pendingPickerPaneId: '' }).success).toBe(false);
  });
});
