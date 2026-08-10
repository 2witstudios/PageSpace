/**
 * The two agent-workspace contracts that outlive the layout model:
 * `session-contract.ts` (session identity + sandbox lifecycle) and
 * `shells-contract.ts` (shells and the shell bridge).
 *
 * This file was `contract.test.ts`, covering all three concerns the one-time
 * `contract.ts` grab-bag held. The third — the pane grid's wire shape
 * (`PANE_KINDS`, `paneScopeSchema`, the `persisted*` family) — is gone with the
 * model it described, and so are its cases.
 */
import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import { SANDBOX_STATUSES, sandboxStatusSchema, agentSessionDtoSchema } from '../session-contract';
import {
  shellDtoSchema,
  shellConnectPayloadSchema,
  clampShellDimensions,
  MIN_COLS,
  MIN_ROWS,
  MAX_COLS,
  MAX_ROWS,
  SHELL_AGENT_TYPES,
  shellReadPayloadSchema,
  shellSendPayloadSchema,
  MAX_SHELLS_PER_READ,
  MAX_SHELL_INPUT_BYTES,
  MAX_SCROLLBACK_TAIL_LINES,
} from '../shells-contract';

const session = {
  workspaceId: 'ses-1',
  // Rolling-deploy compat, one release only — the DTO carries the pre-rename
  // spelling of the same value so a stale browser bundle keeps working.
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
  workspaceId: 'ses-1',
  // Rolling-deploy compat, one release only — the DTO carries the pre-rename
  // spelling of the same value so a stale browser bundle keeps working.
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

  it('given an empty workspaceId, should fail (ids address — an empty one addresses nothing)', () => {
    const result = agentSessionDtoSchema.safeParse({ ...session, workspaceId: '' });
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
    // The inversion of the old rule: workspaceId used to BE the conversation id.
    // A session hosts many conversations, so a conversationId on the session
    // DTO would be a claim about which thread "is" the session — a category
    // error the schema strips rather than models.
    const parsed = agentSessionDtoSchema.parse({ ...session, conversationId: 'conv-1' }) as Record<string, unknown>;
    expect(parsed.conversationId).toBeUndefined();
    expect(parsed.workspaceId).toBe('ses-1');
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
      workspaceId: 'ses-1',
    }) as Record<string, unknown>;
    expect(parsed.machineId).toBeUndefined();
    expect(parsed.projectName).toBeUndefined();
    expect(parsed.branchName).toBeUndefined();
    expect(parsed.workspaceId).toBeUndefined();
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
