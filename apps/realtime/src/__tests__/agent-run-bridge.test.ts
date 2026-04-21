import { describe, it, expect, vi } from 'vitest';

vi.mock('@pagespace/lib/logger-config', () => ({
  loggers: {
    realtime: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  },
}));

vi.mock('@pagespace/lib/permissions', () => ({
  getUserAccessLevel: vi.fn(),
  getUserDriveAccess: vi.fn(),
}));

const { dbState } = vi.hoisted(() => ({
  dbState: {
    agentRun: null as Record<string, unknown> | null,
    conversation: null as Record<string, unknown> | null,
  },
}));

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      agentRuns: {
        findFirst: vi.fn(async () => dbState.agentRun),
      },
      conversations: {
        findFirst: vi.fn(async () => dbState.conversation),
      },
    },
  },
  agentRuns: { id: 'agentRuns.id' },
  conversations: { id: 'conversations.id' },
  eq: vi.fn(() => 'eq'),
}));

import {
  parseAgentRunNotification,
  emitAgentRunNotification,
  isAgentRunAccessibleDefault,
  validateRunId,
  startAgentRunBridge,
} from '../agent-run-bridge';
import { getUserAccessLevel, getUserDriveAccess } from '@pagespace/lib/permissions';

describe('parseAgentRunNotification', () => {
  it('given a valid JSON payload, should return the parsed notification', () => {
    const result = parseAgentRunNotification(
      JSON.stringify({ runId: 'abc12345xyz', seq: 7, type: 'text-segment' }),
    );
    expect(result).toEqual({ runId: 'abc12345xyz', seq: 7, type: 'text-segment' });
  });

  it('given a malformed JSON payload, should return null so a bad notify cannot crash the bridge', () => {
    expect(parseAgentRunNotification('not-json')).toBeNull();
  });

  it('given a payload with non-CUID2 runId, should return null', () => {
    expect(
      parseAgentRunNotification(JSON.stringify({ runId: 'A!@#', seq: 1, type: 'finish' })),
    ).toBeNull();
  });

  it('given a payload with non-positive seq, should return null', () => {
    expect(
      parseAgentRunNotification(JSON.stringify({ runId: 'abc12345xyz', seq: 0, type: 'finish' })),
    ).toBeNull();
  });

  it('given a payload missing the type field, should return null', () => {
    expect(
      parseAgentRunNotification(JSON.stringify({ runId: 'abc12345xyz', seq: 1 })),
    ).toBeNull();
  });

  it('given a payload with empty type string, should return null', () => {
    expect(
      parseAgentRunNotification(JSON.stringify({ runId: 'abc12345xyz', seq: 1, type: '' })),
    ).toBeNull();
  });

  it('given a non-object JSON value, should return null', () => {
    expect(parseAgentRunNotification('"a string"')).toBeNull();
    expect(parseAgentRunNotification('null')).toBeNull();
  });
});

describe('emitAgentRunNotification', () => {
  it('given an io and notification, should emit agent_run_event to the agent-run room keyed by runId', () => {
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    emitAgentRunNotification({ to } as never, {
      runId: 'abc12345xyz',
      seq: 3,
      type: 'tool-input',
    });
    expect(to).toHaveBeenCalledWith('agent-run:abc12345xyz');
    expect(emit).toHaveBeenCalledWith('agent_run_event', {
      runId: 'abc12345xyz',
      seq: 3,
      type: 'tool-input',
    });
  });
});

describe('validateRunId', () => {
  it('given a CUID2 string, should accept it', () => {
    const r = validateRunId('abc12345xyz');
    expect(r.ok).toBe(true);
  });

  it('given a non-CUID2 string, should reject it', () => {
    const r = validateRunId('A!@#');
    expect(r.ok).toBe(false);
  });

  it('given a non-string value, should reject it', () => {
    expect(validateRunId(123).ok).toBe(false);
    expect(validateRunId(null).ok).toBe(false);
  });
});

describe('isAgentRunAccessibleDefault', () => {
  beforeEach(() => {
    dbState.agentRun = null;
    dbState.conversation = null;
    vi.mocked(getUserAccessLevel).mockReset();
    vi.mocked(getUserDriveAccess).mockReset();
  });

  it('given a missing run, should return false', async () => {
    expect(await isAgentRunAccessibleDefault('user_1', 'run_1')).toBe(false);
  });

  it('given the user owns the run, should return true without checking conversation access', async () => {
    dbState.agentRun = { id: 'run_1', ownerUserId: 'user_1', conversationId: 'conv_1' };
    expect(await isAgentRunAccessibleDefault('user_1', 'run_1')).toBe(true);
  });

  it('given a missing conversation row, should return false', async () => {
    dbState.agentRun = { id: 'run_1', ownerUserId: 'other', conversationId: 'conv_missing' };
    expect(await isAgentRunAccessibleDefault('user_1', 'run_1')).toBe(false);
  });

  it('given a conversation owned by the user, should return true', async () => {
    dbState.agentRun = { id: 'run_1', ownerUserId: 'other', conversationId: 'conv_1' };
    dbState.conversation = { id: 'conv_1', userId: 'user_1', type: 'page', contextId: 'page_1' };
    expect(await isAgentRunAccessibleDefault('user_1', 'run_1')).toBe(true);
  });

  it('given a page conversation and the user has view access on the page, should return true', async () => {
    dbState.agentRun = { id: 'run_1', ownerUserId: 'other', conversationId: 'conv_1' };
    dbState.conversation = { id: 'conv_1', userId: 'other', type: 'page', contextId: 'page_1' };
    vi.mocked(getUserAccessLevel).mockResolvedValue({ canView: true } as never);
    expect(await isAgentRunAccessibleDefault('user_1', 'run_1')).toBe(true);
  });

  it('given a page conversation and the user lacks view access, should return false', async () => {
    dbState.agentRun = { id: 'run_1', ownerUserId: 'other', conversationId: 'conv_1' };
    dbState.conversation = { id: 'conv_1', userId: 'other', type: 'page', contextId: 'page_1' };
    vi.mocked(getUserAccessLevel).mockResolvedValue(null);
    expect(await isAgentRunAccessibleDefault('user_1', 'run_1')).toBe(false);
  });

  it('given a drive conversation and the user has drive access, should return true', async () => {
    dbState.agentRun = { id: 'run_1', ownerUserId: 'other', conversationId: 'conv_1' };
    dbState.conversation = { id: 'conv_1', userId: 'other', type: 'drive', contextId: 'drive_1' };
    vi.mocked(getUserDriveAccess).mockResolvedValue(true as never);
    expect(await isAgentRunAccessibleDefault('user_1', 'run_1')).toBe(true);
  });

  it('given a global conversation owned by another user, should return false', async () => {
    dbState.agentRun = { id: 'run_1', ownerUserId: 'other', conversationId: 'conv_1' };
    dbState.conversation = { id: 'conv_1', userId: 'other', type: 'global', contextId: null };
    expect(await isAgentRunAccessibleDefault('user_1', 'run_1')).toBe(false);
  });
});

describe('startAgentRunBridge', () => {
  type Listener = (...args: unknown[]) => void;

  function makeFakeClient() {
    const handlers = new Map<string, Listener[]>();
    const queries: string[] = [];
    return {
      handlers,
      queries,
      on: (event: string, cb: Listener) => {
        const list = handlers.get(event) ?? [];
        list.push(cb);
        handlers.set(event, list);
      },
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return undefined;
      }),
      release: vi.fn(),
      emit: (event: string, ...args: unknown[]) => {
        for (const cb of handlers.get(event) ?? []) cb(...args);
      },
    };
  }

  it('given startup, should LISTEN on agent_run_events and forward notifications to the matching room', async () => {
    const fake = makeFakeClient();
    const pool = { connect: vi.fn().mockResolvedValue(fake) };
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));

    const dispose = await startAgentRunBridge({
      pool: pool as never,
      io: { to } as never,
    });

    expect(fake.queries).toContain('LISTEN agent_run_events');

    fake.emit('notification', {
      channel: 'agent_run_events',
      payload: JSON.stringify({ runId: 'abc12345xyz', seq: 1, type: 'finish' }),
    });

    expect(to).toHaveBeenCalledWith('agent-run:abc12345xyz');
    expect(emit).toHaveBeenCalledWith('agent_run_event', {
      runId: 'abc12345xyz',
      seq: 1,
      type: 'finish',
    });

    await dispose();
    expect(fake.queries).toContain('UNLISTEN agent_run_events');
    expect(fake.release).toHaveBeenCalled();
  });

  it('given a notification on a different channel, should ignore it', async () => {
    const fake = makeFakeClient();
    const pool = { connect: vi.fn().mockResolvedValue(fake) };
    const to = vi.fn();

    await startAgentRunBridge({ pool: pool as never, io: { to } as never });
    fake.emit('notification', { channel: 'other_channel', payload: 'x' });
    expect(to).not.toHaveBeenCalled();
  });

  it('given a malformed notification payload, should drop it without throwing', async () => {
    const fake = makeFakeClient();
    const pool = { connect: vi.fn().mockResolvedValue(fake) };
    const to = vi.fn();

    await startAgentRunBridge({ pool: pool as never, io: { to } as never });
    expect(() =>
      fake.emit('notification', { channel: 'agent_run_events', payload: 'not-json' }),
    ).not.toThrow();
    expect(to).not.toHaveBeenCalled();
  });

  it('given an UNLISTEN that fails on shutdown, should still release the client', async () => {
    const fake = makeFakeClient();
    fake.query = vi.fn(async (sql: string) => {
      if (sql.startsWith('UNLISTEN')) throw new Error('shutdown');
      return undefined;
    });
    const pool = { connect: vi.fn().mockResolvedValue(fake) };

    const dispose = await startAgentRunBridge({
      pool: pool as never,
      io: { to: vi.fn() } as never,
    });
    await dispose();
    expect(fake.release).toHaveBeenCalled();
  });

  it('given a pg client error, should log it via loggers.realtime.error without crashing', async () => {
    const fake = makeFakeClient();
    const pool = { connect: vi.fn().mockResolvedValue(fake) };

    await startAgentRunBridge({ pool: pool as never, io: { to: vi.fn() } as never });
    expect(() => fake.emit('error', new Error('boom'))).not.toThrow();
  });
});
