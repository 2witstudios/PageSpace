import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFindFirst, mockEq, mockLookupDriveOwnerId } = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
  mockEq: vi.fn(),
  mockLookupDriveOwnerId: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: { users: { findFirst: mockFindFirst } },
  },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: mockEq }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'users.id', subscriptionTier: 'subscriptionTier' } }));
// The drive→owner read lives in sandbox-payer and lazily imports its OWN db
// module (a different resolved instance than this app's `@pagespace/db/db`
// mock, so mocking the db here can never intercept it) — mock the seam itself.
vi.mock('@pagespace/lib/billing/sandbox-payer', () => ({
  lookupDriveOwnerId: mockLookupDriveOwnerId,
}));

import { resolveSandboxToolEligibility } from '../sandbox-tool-eligibility';

describe('resolveSandboxToolEligibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('given a driveless (global) context, checks the given userId directly', async () => {
    mockFindFirst.mockResolvedValue({ subscriptionTier: 'pro' });
    const result = await resolveSandboxToolEligibility(null, 'user-1');
    expect(result).toBe(true);
    expect(mockLookupDriveOwnerId).not.toHaveBeenCalled();
    expect(mockEq).toHaveBeenCalledWith('users.id', 'user-1');
  });

  it('given a drive-scoped context, checks the DRIVE OWNER, not the given userId', async () => {
    mockLookupDriveOwnerId.mockResolvedValue('drive-owner');
    mockFindFirst.mockResolvedValue({ subscriptionTier: 'pro' });
    const result = await resolveSandboxToolEligibility('drive-1', 'free-tier-actor');
    expect(result).toBe(true);
    expect(mockLookupDriveOwnerId).toHaveBeenCalledWith('drive-1');
    // The tier row consulted is the PAYER's (the drive owner), never the actor's.
    expect(mockEq).toHaveBeenCalledWith('users.id', 'drive-owner');
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
