import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
  },
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: {
    id: 'id', title: 'title', type: 'type', driveId: 'driveId',
    systemPrompt: 'systemPrompt', enabledTools: 'enabledTools',
    aiProvider: 'aiProvider', aiModel: 'aiModel', agentDefinition: 'agentDefinition',
    visibleToGlobalAssistant: 'visibleToGlobalAssistant',
    includeDrivePrompt: 'includeDrivePrompt', includePageTree: 'includePageTree',
    pageTreeScope: 'pageTreeScope', revision: 'revision', stateHash: 'stateHash',
    isTrashed: 'isTrashed',
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((_a, _b) => 'eq'),
  and: vi.fn((...args) => ({ and: args })),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { agentRepository } from '../agent-repository';
import { db } from '@pagespace/db/db';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const agentRow = {
  id: 'agent-1',
  title: 'My Agent',
  type: 'AI_CHAT',
  driveId: 'drive-1',
  systemPrompt: 'You are helpful.',
  enabledTools: ['search', 'read'],
  aiProvider: 'openrouter',
  aiModel: 'claude-3',
  agentDefinition: null,
  visibleToGlobalAssistant: true,
  includeDrivePrompt: false,
  includePageTree: false,
  pageTreeScope: null,
  revision: 1,
  stateHash: 'abc123',
};

function setupSelectChain(rows: unknown[]) {
  const limitFn = vi.fn().mockResolvedValue(rows);
  const whereFn = vi.fn().mockReturnValue({ limit: limitFn });
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });
  vi.mocked(db.select).mockImplementation(selectFn);
  return { limitFn, whereFn };
}

function setupUpdateChain() {
  const whereFn = vi.fn().mockResolvedValue(undefined);
  const setFn = vi.fn().mockReturnValue({ where: whereFn });
  vi.mocked(db.update).mockReturnValue({ set: setFn } as unknown as ReturnType<typeof db.update>);
  return { setFn, whereFn };
}

// ---------------------------------------------------------------------------
// findById
// ---------------------------------------------------------------------------
describe('agentRepository.findById', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns agent record when found', async () => {
    setupSelectChain([agentRow]);

    const result = await agentRepository.findById('agent-1');

    expect(result).not.toBeNull();
    expect(result?.id).toBe('agent-1');
    expect(result?.title).toBe('My Agent');
    expect(result?.type).toBe('AI_CHAT');
  });

  it('returns null when agent not found', async () => {
    setupSelectChain([]);

    const result = await agentRepository.findById('nonexistent');
    expect(result).toBeNull();
  });

  it('defaults visibleToGlobalAssistant to true when null', async () => {
    setupSelectChain([{ ...agentRow, visibleToGlobalAssistant: null }]);

    const result = await agentRepository.findById('agent-1');
    expect(result?.visibleToGlobalAssistant).toBe(true);
  });

  it('defaults includeDrivePrompt to false when null', async () => {
    setupSelectChain([{ ...agentRow, includeDrivePrompt: null }]);

    const result = await agentRepository.findById('agent-1');
    expect(result?.includeDrivePrompt).toBe(false);
  });

  it('defaults includePageTree to false when null', async () => {
    setupSelectChain([{ ...agentRow, includePageTree: null }]);

    const result = await agentRepository.findById('agent-1');
    expect(result?.includePageTree).toBe(false);
  });

  it('preserves enabledTools as array', async () => {
    setupSelectChain([{ ...agentRow, enabledTools: ['tool-a', 'tool-b'] }]);

    const result = await agentRepository.findById('agent-1');
    expect(result?.enabledTools).toEqual(['tool-a', 'tool-b']);
  });

  it('returns null enabledTools when null', async () => {
    setupSelectChain([{ ...agentRow, enabledTools: null }]);

    const result = await agentRepository.findById('agent-1');
    expect(result?.enabledTools).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// updateConfig
// ---------------------------------------------------------------------------
describe('agentRepository.updateConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls db.update with provided config', async () => {
    const { setFn } = setupUpdateChain();

    await agentRepository.updateConfig('agent-1', {
      systemPrompt: 'New prompt',
      aiModel: 'gpt-4',
    });

    expect(db.update).toHaveBeenCalled();
    expect(setFn).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: 'New prompt',
      aiModel: 'gpt-4',
    }));
  });

  it('sets updatedAt to current time when not provided', async () => {
    const { setFn } = setupUpdateChain();
    const beforeUpdate = new Date();

    await agentRepository.updateConfig('agent-1', { systemPrompt: 'prompt' });

    const callArg = setFn.mock.calls[0][0] as { updatedAt: Date };
    expect(callArg.updatedAt).toBeInstanceOf(Date);
    expect(callArg.updatedAt.getTime()).toBeGreaterThanOrEqual(beforeUpdate.getTime());
  });

  it('uses provided updatedAt when specified', async () => {
    const { setFn } = setupUpdateChain();
    const customDate = new Date('2024-01-01T00:00:00Z');

    await agentRepository.updateConfig('agent-1', { updatedAt: customDate });

    const callArg = setFn.mock.calls[0][0] as { updatedAt: Date };
    expect(callArg.updatedAt).toEqual(customDate);
  });

  it('handles empty config update', async () => {
    setupUpdateChain();

    await expect(agentRepository.updateConfig('agent-1', {})).resolves.not.toThrow();
  });
});
