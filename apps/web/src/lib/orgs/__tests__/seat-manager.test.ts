import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the entire seat-manager module's dependencies at a higher level
vi.mock('@pagespace/db', () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockResolvedValue([]),
  },
  eq: vi.fn(),
  and: vi.fn(),
  organizations: {},
  orgSubscriptions: {},
}));

vi.mock('../../stripe', () => ({
  stripe: {
    subscriptions: {
      update: vi.fn().mockResolvedValue({}),
      retrieve: vi.fn().mockResolvedValue({
        items: { data: [{ id: 'si_item1' }] },
      }),
    },
  },
}));

vi.mock('../guardrails', () => ({
  getOrgMemberCount: vi.fn(),
}));

import { getOrgMemberCount } from '../guardrails';
import {
  updateSeatCount,
} from '../seat-manager';

// Test the pure validation logic of updateSeatCount
// by importing and testing getActiveOrgSubscription behavior indirectly

const mockGetOrgMemberCount = vi.mocked(getOrgMemberCount);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('updateSeatCount', () => {
  it('should reject seat count below 1', async () => {
    const result = await updateSeatCount('org-1', 0);

    expect(result.success).toBe(false);
    expect(result.error).toContain('at least 1');
  });

  it('should reject negative seat count', async () => {
    const result = await updateSeatCount('org-1', -5);

    expect(result.success).toBe(false);
    expect(result.error).toContain('at least 1');
  });
});

describe('updateSeatCount validation', () => {
  it('should validate minimum seat count before any DB call', async () => {
    const result = await updateSeatCount('org-1', 0);

    expect(result).toEqual({
      success: false,
      error: 'Seat count must be at least 1',
    });
    // Should not have tried to fetch subscription
    expect(mockGetOrgMemberCount).not.toHaveBeenCalled();
  });
});
