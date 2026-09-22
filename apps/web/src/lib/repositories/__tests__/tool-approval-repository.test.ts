/**
 * Unit tests for toolApprovalRepository — the seam where the atomic decision
 * claim and the grant queries meet Drizzle. Mocks @pagespace/db/db to verify
 * the query SHAPES: the on-conflict target that makes the claim exactly-once,
 * the scope filter that keeps other conversations' grants out, and the owner
 * filter on revoke.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockInsertChain = vi.hoisted(() => ({ values: vi.fn(), onConflictDoNothing: vi.fn(), returning: vi.fn() }));
const mockUpdateChain = vi.hoisted(() => ({ set: vi.fn(), where: vi.fn(), returning: vi.fn() }));
const mockSelectChain = vi.hoisted(() => ({ from: vi.fn(), where: vi.fn() }));
const mockDeleteChain = vi.hoisted(() => ({ where: vi.fn(), returning: vi.fn() }));

vi.mock('@pagespace/db/db', () => ({
  db: {
    insert: vi.fn(() => mockInsertChain),
    update: vi.fn(() => mockUpdateChain),
    select: vi.fn(() => mockSelectChain),
    delete: vi.fn(() => mockDeleteChain),
  },
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((field, value) => ({ kind: 'eq', field, value })),
  and: vi.fn((...conditions) => ({ kind: 'and', conditions })),
  or: vi.fn((...conditions) => ({ kind: 'or', conditions })),
  isNull: vi.fn((field) => ({ kind: 'isNull', field })),
  inArray: vi.fn((field, values) => ({ kind: 'inArray', field, values })),
  lt: vi.fn((field, value) => ({ kind: 'lt', field, value })),
}));

vi.mock('@pagespace/db/schema/tool-approvals', () => ({
  aiToolApprovalGrants: {
    id: 'grants.id',
    userId: 'grants.userId',
    toolName: 'grants.toolName',
    conversationId: 'grants.conversationId',
    createdAt: 'grants.createdAt',
  },
  aiToolApprovalDecisions: {
    approvalId: 'decisions.approvalId',
    outcome: 'decisions.outcome',
    executedAt: 'decisions.executedAt',
  },
}));

import { toolApprovalRepository } from '../tool-approval-repository';

const claimInput = {
  approvalId: 'ap1',
  toolCallId: 'tc1',
  toolName: 'trash_page',
  messageId: 'm1',
  conversationId: 'c1',
  userId: 'u1',
  approved: true,
  scope: 'conversation' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockInsertChain.values.mockReturnValue(mockInsertChain);
  mockInsertChain.onConflictDoNothing.mockReturnValue(mockInsertChain);
  mockUpdateChain.set.mockReturnValue(mockUpdateChain);
  mockUpdateChain.where.mockReturnValue(mockUpdateChain);
  mockUpdateChain.returning.mockResolvedValue([]);
  mockSelectChain.from.mockReturnValue(mockSelectChain);
  mockSelectChain.where.mockResolvedValue([]);
  mockDeleteChain.where.mockReturnValue(mockDeleteChain);
  mockDeleteChain.returning.mockResolvedValue([]);
});

describe('claimDecision', () => {
  it('given the insert returns a row, should report the claim won and target the approval id for the conflict', async () => {
    mockInsertChain.returning.mockResolvedValue([{ approvalId: 'ap1' }]);
    const won = await toolApprovalRepository.claimDecision(claimInput);
    expect(won).toEqual({ approvalId: 'ap1' });
    expect(mockInsertChain.onConflictDoNothing).toHaveBeenCalledWith({ target: 'decisions.approvalId' });
    expect(mockInsertChain.returning).toHaveBeenCalled();
  });

  it('given the insert returns nothing (someone already decided), should report null and never throw', async () => {
    mockInsertChain.returning.mockResolvedValue([]);
    expect(await toolApprovalRepository.claimDecision(claimInput)).toBeNull();
  });

  it('given an approval, should default the scope to once; given a denial, should store no scope', async () => {
    mockInsertChain.returning.mockResolvedValue([{ approvalId: 'ap1' }]);
    await toolApprovalRepository.claimDecision({ ...claimInput, scope: undefined });
    expect(mockInsertChain.values).toHaveBeenLastCalledWith(expect.objectContaining({ approved: true, scope: 'once' }));
    await toolApprovalRepository.claimDecision({ ...claimInput, approved: false, scope: 'always', reason: 'no' });
    expect(mockInsertChain.values).toHaveBeenLastCalledWith(expect.objectContaining({ approved: false, scope: null, reason: 'no' }));
  });
});

describe('listGrants', () => {
  it('given a conversation, should select user-wide grants OR grants for that conversation only', async () => {
    await toolApprovalRepository.listGrants('u1', 'c1');
    expect(mockSelectChain.where).toHaveBeenCalledWith({
      kind: 'and',
      conditions: [
        { kind: 'eq', field: 'grants.userId', value: 'u1' },
        {
          kind: 'or',
          conditions: [
            { kind: 'isNull', field: 'grants.conversationId' },
            { kind: 'eq', field: 'grants.conversationId', value: 'c1' },
          ],
        },
      ],
    });
  });

  it('given no conversation, should select only user-wide grants', async () => {
    await toolApprovalRepository.listGrants('u1', null);
    expect(mockSelectChain.where).toHaveBeenCalledWith({
      kind: 'and',
      conditions: [
        { kind: 'eq', field: 'grants.userId', value: 'u1' },
        { kind: 'isNull', field: 'grants.conversationId' },
      ],
    });
  });
});

describe('addGrant / revokeGrant', () => {
  it('addGrant should insert with on-conflict-do-nothing so a repeated grant is a no-op', async () => {
    mockInsertChain.onConflictDoNothing.mockResolvedValue(undefined);
    await toolApprovalRepository.addGrant({ userId: 'u1', toolName: 'trash_page', conversationId: null });
    expect(mockInsertChain.values).toHaveBeenCalledWith({ userId: 'u1', toolName: 'trash_page', conversationId: null });
    expect(mockInsertChain.onConflictDoNothing).toHaveBeenCalled();
  });

  it('revokeGrant should filter by BOTH grant id and owner, and report whether a row went', async () => {
    mockDeleteChain.returning.mockResolvedValue([{ id: 'g1' }]);
    expect(await toolApprovalRepository.revokeGrant({ userId: 'u1', grantId: 'g1' })).toBe(true);
    expect(mockDeleteChain.where).toHaveBeenCalledWith({
      kind: 'and',
      conditions: [
        { kind: 'eq', field: 'grants.id', value: 'g1' },
        { kind: 'eq', field: 'grants.userId', value: 'u1' },
      ],
    });
    mockDeleteChain.returning.mockResolvedValue([]);
    expect(await toolApprovalRepository.revokeGrant({ userId: 'u2', grantId: 'g1' })).toBe(false);
  });
});

describe('markExecuted', () => {
  it('should stamp executedAt and the outcome on the decision row', async () => {
    await toolApprovalRepository.markExecuted('ap1', 'ok');
    expect(mockUpdateChain.set).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'ok', executedAt: expect.any(Date) }));
    expect(mockUpdateChain.where).toHaveBeenCalledWith({ kind: 'eq', field: 'decisions.approvalId', value: 'ap1' });
  });
});

describe('outcome claims (the arbiter of what happened to an approved call)', () => {
  it('claimExecutionStart: given the row is undecided-on-outcome (NULL), should move it to running and report won', async () => {
    mockUpdateChain.returning.mockResolvedValue([{ approvalId: 'ap1' }]);
    expect(await toolApprovalRepository.claimExecutionStart('ap1')).toBe(true);
    expect(mockUpdateChain.set).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'running', executedAt: expect.any(Date) }));
    expect(mockUpdateChain.where).toHaveBeenCalledWith({
      kind: 'and',
      conditions: [
        { kind: 'eq', field: 'decisions.approvalId', value: 'ap1' },
        { kind: 'isNull', field: 'decisions.outcome' },
      ],
    });
  });

  it('claimExecutionStart: given the outcome is already set (stale/denied/ok), should report lost and change nothing', async () => {
    mockUpdateChain.returning.mockResolvedValue([]);
    expect(await toolApprovalRepository.claimExecutionStart('ap1')).toBe(false);
  });

  it('claimStale: given an undecided outcome OR a running one older than the stale window, should move it to stale; otherwise lost', async () => {
    mockUpdateChain.returning.mockResolvedValue([{ approvalId: 'ap1' }]);
    expect(await toolApprovalRepository.claimStale('ap1')).toBe(true);
    expect(mockUpdateChain.set).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'stale' }));
    expect(mockUpdateChain.where).toHaveBeenCalledWith({
      kind: 'and',
      conditions: [
        { kind: 'eq', field: 'decisions.approvalId', value: 'ap1' },
        {
          kind: 'or',
          conditions: [
            { kind: 'isNull', field: 'decisions.outcome' },
            {
              kind: 'and',
              conditions: [
                { kind: 'eq', field: 'decisions.outcome', value: 'running' },
                { kind: 'lt', field: 'decisions.executedAt', value: expect.any(Date) },
              ],
            },
          ],
        },
      ],
    });
    mockUpdateChain.returning.mockResolvedValue([]);
    expect(await toolApprovalRepository.claimStale('ap1')).toBe(false);
  });

  it('recordOutcome: given a running OR stale row, should write the real result (truth wins over stale); given anything else, lost', async () => {
    mockUpdateChain.returning.mockResolvedValue([{ approvalId: 'ap1' }]);
    expect(await toolApprovalRepository.recordOutcome('ap1', 'ok')).toBe(true);
    expect(mockUpdateChain.set).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'ok', executedAt: expect.any(Date) }));
    expect(mockUpdateChain.where).toHaveBeenCalledWith({
      kind: 'and',
      conditions: [
        { kind: 'eq', field: 'decisions.approvalId', value: 'ap1' },
        { kind: 'inArray', field: 'decisions.outcome', values: ['running', 'stale'] },
      ],
    });
    mockUpdateChain.returning.mockResolvedValue([]);
    expect(await toolApprovalRepository.recordOutcome('ap1', 'error')).toBe(false);
  });
});
