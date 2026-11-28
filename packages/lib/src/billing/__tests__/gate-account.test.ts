import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLimit = vi.hoisted(() => vi.fn());
vi.mock('@pagespace/db/db', () => ({
  db: { select: () => ({ from: () => ({ leftJoin: () => ({ where: () => ({ limit: mockLimit }) }) }) }) },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn() }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'u.id', accountType: 'u.accountType' } }));
vi.mock('@pagespace/db/schema/agent-identities', () => ({
  agentIdentities: { userId: 'ai.userId', ownerUserId: 'ai.ownerUserId' },
}));

import { readGateAccount } from '../gate-account';
import { GateAccountNotFoundError } from '../gate-account-not-found';

describe('readGateAccount', () => {
  beforeEach(() => vi.resetAllMocks());

  it('given an unclaimed agent row, should return it with no owner', async () => {
    mockLimit.mockResolvedValue([{ accountType: 'agent', ownerUserId: null }]);
    expect(await readGateAccount('a1')).toEqual({ accountType: 'agent', ownerUserId: null });
  });

  it('given a claimed agent row, should return its owner', async () => {
    mockLimit.mockResolvedValue([{ accountType: 'agent', ownerUserId: 'owner_1' }]);
    expect(await readGateAccount('a1')).toEqual({ accountType: 'agent', ownerUserId: 'owner_1' });
  });

  it('given no users row, should fail closed with a typed error rather than default to human', async () => {
    mockLimit.mockResolvedValue([]);
    const read = readGateAccount('ghost');
    await expect(read).rejects.toBeInstanceOf(GateAccountNotFoundError);
    await expect(read).rejects.toMatchObject({ userId: 'ghost' });
  });
});
