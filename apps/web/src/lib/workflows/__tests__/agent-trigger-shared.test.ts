import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockQueryPages } = vi.hoisted(() => ({
  mockQueryPages: { findFirst: vi.fn(), findMany: vi.fn() },
}));

vi.mock('@pagespace/db/db', () => ({
  db: { query: { pages: mockQueryPages } },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((field, value) => ({ op: 'eq', field, value })),
  and: vi.fn((...conds) => ({ op: 'and', conds })),
  inArray: vi.fn((field, values) => ({ op: 'inArray', field, values })),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id', type: 'type', isTrashed: 'isTrashed', driveId: 'driveId' },
}));

import {
  validateAgentTrigger,
  agentTriggerBaseSchema,
  MAX_CONTEXT_PAGES,
} from '../agent-trigger-shared';
import { db } from '@pagespace/db/db';

const DRIVE = 'drive-1';

describe('validateAgentTrigger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueryPages.findFirst.mockResolvedValue({ id: 'agent-1', driveId: DRIVE });
    mockQueryPages.findMany.mockResolvedValue([]);
  });

  it('returns the validated agent page id for a prompt-only trigger', async () => {
    const result = await validateAgentTrigger(db, {
      driveId: DRIVE,
      entityLabel: 'task list',
      agentTrigger: { agentPageId: 'agent-1', prompt: 'do the thing' },
    });
    expect(result).toEqual({ agentPageId: 'agent-1' });
  });

  it('rejects a trigger with neither prompt nor instructionPageId', async () => {
    await expect(
      validateAgentTrigger(db, {
        driveId: DRIVE,
        entityLabel: 'task list',
        agentTrigger: { agentPageId: 'agent-1' },
      }),
    ).rejects.toThrow(/either a prompt or instructionPageId/);
  });

  it('rejects when the agent page is not found / not an AI agent', async () => {
    mockQueryPages.findFirst.mockResolvedValueOnce(undefined);
    await expect(
      validateAgentTrigger(db, {
        driveId: DRIVE,
        entityLabel: 'event',
        agentTrigger: { agentPageId: 'missing', prompt: 'x' },
      }),
    ).rejects.toThrow(/not found or not an AI agent/);
  });

  it('rejects when the agent lives in a different drive, naming the entity', async () => {
    mockQueryPages.findFirst.mockResolvedValueOnce({ id: 'agent-1', driveId: 'other-drive' });
    await expect(
      validateAgentTrigger(db, {
        driveId: DRIVE,
        entityLabel: 'event',
        agentTrigger: { agentPageId: 'agent-1', prompt: 'x' },
      }),
    ).rejects.toThrow(/same drive as the event/);
  });

  it('rejects when an instruction page is off-drive or trashed', async () => {
    // first findFirst = agent ok; second findFirst = instruction page missing
    mockQueryPages.findFirst
      .mockResolvedValueOnce({ id: 'agent-1', driveId: DRIVE })
      .mockResolvedValueOnce(undefined);
    await expect(
      validateAgentTrigger(db, {
        driveId: DRIVE,
        entityLabel: 'task list',
        agentTrigger: { agentPageId: 'agent-1', instructionPageId: 'instr-1' },
      }),
    ).rejects.toThrow(/Instruction page not found/);
  });

  it('rejects when some context pages are off-drive', async () => {
    mockQueryPages.findMany.mockResolvedValueOnce([{ id: 'ctx-1' }]); // only 1 of 2 valid
    await expect(
      validateAgentTrigger(db, {
        driveId: DRIVE,
        entityLabel: 'task list',
        agentTrigger: { agentPageId: 'agent-1', prompt: 'x', contextPageIds: ['ctx-1', 'ctx-2'] },
      }),
    ).rejects.toThrow(/context pages were not found/);
  });

  it('rejects more than MAX_CONTEXT_PAGES context pages', async () => {
    const tooMany = Array.from({ length: MAX_CONTEXT_PAGES + 1 }, (_, i) => `ctx-${i}`);
    await expect(
      validateAgentTrigger(db, {
        driveId: DRIVE,
        entityLabel: 'task list',
        agentTrigger: { agentPageId: 'agent-1', prompt: 'x', contextPageIds: tooMany },
      }),
    ).rejects.toThrow(/at most 10 context pages/);
  });
});

describe('agentTriggerBaseSchema', () => {
  it('accepts the shared payload shape', () => {
    const parsed = agentTriggerBaseSchema.parse({
      agentPageId: 'a',
      prompt: 'p',
      instructionPageId: null,
      contextPageIds: ['c1'],
    });
    expect(parsed.agentPageId).toBe('a');
  });

  it('caps contextPageIds at MAX_CONTEXT_PAGES', () => {
    const tooMany = Array.from({ length: MAX_CONTEXT_PAGES + 1 }, (_, i) => `c-${i}`);
    expect(() => agentTriggerBaseSchema.parse({ agentPageId: 'a', contextPageIds: tooMany })).toThrow();
  });
});
