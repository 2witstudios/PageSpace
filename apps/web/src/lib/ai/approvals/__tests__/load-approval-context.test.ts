import { describe, it, expect, vi, beforeEach } from 'vitest';

const getConfig = vi.hoisted(() => vi.fn());
const listGrants = vi.hoisted(() => vi.fn());

/** The page row `db.select(...).from(pages).where(...)` resolves to, or the error it throws. */
const pageRead = vi.hoisted(() => vi.fn());
vi.mock('@pagespace/db/db', () => ({
  db: { select: () => ({ from: () => ({ where: () => pageRead() }) }) },
}));
vi.mock('@pagespace/lib/integrations/repositories/config-repository', () => ({ getConfig }));
vi.mock('@/lib/repositories/tool-approval-repository', () => ({ toolApprovalRepository: { listGrants } }));

import {
  loadGlobalToolApprovalMode,
  loadPageToolApprovalMode,
  loadToolApprovalGrants,
  loadVoiceApprovalPolicy,
} from '../load-approval-context';

const logger = { warn: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadGlobalToolApprovalMode', () => {
  it('returns the stored mode when it is valid', async () => {
    getConfig.mockResolvedValue({ toolApprovalMode: 'auto' });
    expect(await loadGlobalToolApprovalMode('u1', logger)).toBe('auto');
  });

  it('falls back to ask when the row is missing or the value is not a mode', async () => {
    getConfig.mockResolvedValue(null);
    expect(await loadGlobalToolApprovalMode('u1', logger)).toBe('ask');
    getConfig.mockResolvedValue({ toolApprovalMode: 'deny' });
    expect(await loadGlobalToolApprovalMode('u1', logger)).toBe('ask');
  });

  it('fails SAFE: a read error yields ask (never auto) and is logged', async () => {
    getConfig.mockRejectedValue(new Error('db down'));
    expect(await loadGlobalToolApprovalMode('u1', logger)).toBe('ask');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('ask mode'), expect.objectContaining({ error: 'db down' }));
  });
});

describe('loadToolApprovalGrants', () => {
  it('projects rows to the two fields the policy reads and drops malformed ones', async () => {
    listGrants.mockResolvedValue([
      { id: 'g1', toolName: 'trash_page', conversationId: null, createdAt: new Date() },
      { id: 'g2', toolName: 'bash', conversationId: 'c1', createdAt: new Date() },
      { id: 'g3', toolName: undefined, conversationId: null },
    ]);
    expect(await loadToolApprovalGrants('u1', 'c1', logger)).toEqual([
      { toolName: 'trash_page', conversationId: null },
      { toolName: 'bash', conversationId: 'c1' },
    ]);
    expect(listGrants).toHaveBeenCalledWith('u1', 'c1');
  });

  it('fails SAFE: a read error yields no grants (never a phantom grant) and is logged', async () => {
    listGrants.mockRejectedValue(new TypeError('select is not a function'));
    expect(await loadToolApprovalGrants('u1', null, logger)).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('none'), expect.objectContaining({ error: 'select is not a function' }));
  });
});

describe('loadPageToolApprovalMode', () => {
  it('returns the agent page mode when it is valid', async () => {
    pageRead.mockResolvedValue([{ toolApprovalMode: 'auto' }]);
    expect(await loadPageToolApprovalMode('p1', logger)).toBe('auto');
  });

  it('falls back to ask for a missing page', async () => {
    pageRead.mockResolvedValue([]);
    expect(await loadPageToolApprovalMode('p1', logger)).toBe('ask');
  });

  it('fails SAFE: a read error yields ask and is logged', async () => {
    pageRead.mockRejectedValue(new Error('db down'));
    expect(await loadPageToolApprovalMode('p1', logger)).toBe('ask');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('ask mode'), expect.objectContaining({ error: 'db down' }));
  });
});

describe('loadVoiceApprovalPolicy', () => {
  it("reads a bound agent's OWN mode, not the global one, plus this conversation's grants", async () => {
    pageRead.mockResolvedValue([{ toolApprovalMode: 'ask' }]);
    getConfig.mockResolvedValue({ toolApprovalMode: 'auto' });
    listGrants.mockResolvedValue([{ toolName: 'bash', conversationId: null }]);

    expect(await loadVoiceApprovalPolicy({ userId: 'u1', agentPageId: 'p1', conversationId: 'c1' }, logger)).toEqual({
      mode: 'ask',
      interactive: true,
      conversationId: 'c1',
      grants: [{ toolName: 'bash', conversationId: null }],
    });
    expect(getConfig).not.toHaveBeenCalled();
    expect(listGrants).toHaveBeenCalledWith('u1', 'c1');
  });

  it('reads the Global Assistant mode for an unbound call, with standing grants only', async () => {
    getConfig.mockResolvedValue({ toolApprovalMode: 'ask' });
    listGrants.mockResolvedValue([]);

    const policy = await loadVoiceApprovalPolicy({ userId: 'u1' }, logger);
    expect(policy.mode).toBe('ask');
    expect(policy.conversationId).toBeNull();
    expect(listGrants).toHaveBeenCalledWith('u1', null);
  });

  it('skips the grants read in auto mode, where grants cannot matter', async () => {
    getConfig.mockResolvedValue({ toolApprovalMode: 'auto' });

    expect((await loadVoiceApprovalPolicy({ userId: 'u1' }, logger)).mode).toBe('auto');
    expect(listGrants).not.toHaveBeenCalled();
  });

  it('fails SAFE end to end: unreadable mode and grants yield ask with no grants', async () => {
    pageRead.mockRejectedValue(new Error('db down'));
    listGrants.mockRejectedValue(new Error('db down'));

    expect(await loadVoiceApprovalPolicy({ userId: 'u1', agentPageId: 'p1' }, logger)).toEqual({
      mode: 'ask',
      interactive: true,
      conversationId: null,
      grants: [],
    });
  });
});
