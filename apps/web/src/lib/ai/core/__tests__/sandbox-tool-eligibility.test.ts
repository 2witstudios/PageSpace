import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFindFirst, mockDriveSelect } = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
  mockDriveSelect: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: { users: { findFirst: mockFindFirst } },
    select: () => ({ from: () => ({ where: () => ({ limit: mockDriveSelect }) }) }),
  },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn() }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'id', subscriptionTier: 'subscriptionTier' } }));

import { resolveSandboxToolEligibility } from '../sandbox-tool-eligibility';

describe('resolveSandboxToolEligibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('given a driveless (global) context, checks the given userId directly', async () => {
    mockFindFirst.mockResolvedValue({ subscriptionTier: 'pro' });
    const result = await resolveSandboxToolEligibility(null, 'user-1');
    expect(result).toBe(true);
    expect(mockFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: undefined, columns: { subscriptionTier: true } }),
    );
  });

  it('given a drive-scoped context, checks the DRIVE OWNER, not the given userId', async () => {
    mockDriveSelect.mockResolvedValue([{ ownerId: 'drive-owner' }]);
    mockFindFirst.mockResolvedValue({ subscriptionTier: 'pro' });
    const result = await resolveSandboxToolEligibility('drive-1', 'free-tier-actor');
    expect(result).toBe(true);
  });

  it('given a free-tier payer, denies', async () => {
    mockFindFirst.mockResolvedValue({ subscriptionTier: 'free' });
    const result = await resolveSandboxToolEligibility(null, 'user-1');
    expect(result).toBe(false);
  });

  it('given no user row found, defaults to free and denies', async () => {
    mockFindFirst.mockResolvedValue(undefined);
    const result = await resolveSandboxToolEligibility(null, 'user-1');
    expect(result).toBe(false);
  });
});
