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
