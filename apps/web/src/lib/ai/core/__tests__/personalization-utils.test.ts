import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const mockFindFirst = vi.fn();
  const mockFrom = vi.fn();
  return { mockFindFirst, mockFrom };
});

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      userPersonalization: {
        findFirst: mocks.mockFindFirst,
      },
    },
    select: vi.fn(() => ({ from: mocks.mockFrom })),
  },
  users: {
    id: 'id',
    timezone: 'timezone',
  },
  userPersonalization: {
    userId: 'userId',
  },
  eq: vi.fn((a, b) => ({ eq: true, a, b })),
}));

vi.mock('../system-prompt', () => ({
  buildPersonalizationPrompt: vi.fn(),
}));

import { getUserPersonalization, getUserTimezone } from '../personalization-utils';

describe('personalization-utils', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getUserPersonalization', () => {
    it('should return null when no personalization record found', async () => {
      mocks.mockFindFirst.mockResolvedValue(null);
      const result = await getUserPersonalization('user-1');
      expect(result).toBeNull();
    });

    it('should return null when personalization is disabled', async () => {
      mocks.mockFindFirst.mockResolvedValue({
        userId: 'user-1',
        enabled: false,
        bio: 'Some bio',
        writingStyle: 'Casual',
        rules: 'No rules',
      });

      const result = await getUserPersonalization('user-1');
      expect(result).toBeNull();
    });

    it('should return personalization info when enabled', async () => {
      mocks.mockFindFirst.mockResolvedValue({
        userId: 'user-1',
        enabled: true,
        bio: 'I am a developer',
        writingStyle: 'Concise',
        rules: 'Always TypeScript',
      });

      const result = await getUserPersonalization('user-1');
      expect(result).toEqual({
        bio: 'I am a developer',
        writingStyle: 'Concise',
        rules: 'Always TypeScript',
        enabled: true,
      });
    });

    it('should handle null bio, writingStyle, and rules', async () => {
      mocks.mockFindFirst.mockResolvedValue({
        userId: 'user-1',
        enabled: true,
        bio: null,
        writingStyle: null,
        rules: null,
      });

      const result = await getUserPersonalization('user-1');
      expect(result).toEqual({
        bio: undefined,
        writingStyle: undefined,
        rules: undefined,
        enabled: true,
      });
    });

    it('should return null on database error', async () => {
      mocks.mockFindFirst.mockRejectedValue(new Error('DB error'));
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await getUserPersonalization('user-1');
      expect(result).toBeNull();
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('should query with the correct userId', async () => {
      mocks.mockFindFirst.mockResolvedValue(null);

      await getUserPersonalization('specific-user-id');

      expect(mocks.mockFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.anything() })
      );
    });
  });

  describe('getUserTimezone', () => {
    it('should return timezone when user has one', async () => {
      mocks.mockFrom.mockReturnValue({
        where: vi.fn().mockResolvedValue([{ timezone: 'America/New_York' }]),
      });

      const result = await getUserTimezone('user-1');
      expect(result).toBe('America/New_York');
    });

    it('should return undefined when user has no timezone', async () => {
      mocks.mockFrom.mockReturnValue({
        where: vi.fn().mockResolvedValue([{ timezone: null }]),
      });

      const result = await getUserTimezone('user-1');
      expect(result).toBeUndefined();
    });

    it('should return undefined when user not found', async () => {
      mocks.mockFrom.mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      });

      const result = await getUserTimezone('user-1');
      expect(result).toBeUndefined();
    });

    it('should return undefined on error', async () => {
      mocks.mockFrom.mockReturnValue({
        where: vi.fn().mockRejectedValue(new Error('DB error')),
      });

      const result = await getUserTimezone('user-1');
      expect(result).toBeUndefined();
    });
  });
});
