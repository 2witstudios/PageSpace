import { describe, it, expect, vi, beforeEach } from 'vitest';

const getConfig = vi.hoisted(() => vi.fn());
const listGrants = vi.hoisted(() => vi.fn());

vi.mock('@pagespace/db/db', () => ({ db: {} }));
vi.mock('@pagespace/lib/integrations/repositories/config-repository', () => ({ getConfig }));
vi.mock('@/lib/repositories/tool-approval-repository', () => ({ toolApprovalRepository: { listGrants } }));

import { loadGlobalToolApprovalMode, loadToolApprovalGrants } from '../load-approval-context';

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
