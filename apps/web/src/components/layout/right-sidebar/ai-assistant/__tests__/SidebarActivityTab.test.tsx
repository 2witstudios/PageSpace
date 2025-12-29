import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import {
  getActorDisplayName,
  type ActivityItem,
} from '../SidebarActivityTab';

// Mock next/navigation for component integration tests
vi.mock('next/navigation', () => ({
  useParams: vi.fn(() => ({})),
  usePathname: vi.fn(() => '/dashboard'),
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  })),
}));

// Mock fetchWithAuth for component integration tests
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
}));

// Mock useActivitySocket to avoid socket dependencies in tests
vi.mock('@/hooks/useActivitySocket', () => ({
  useActivitySocket: vi.fn(() => ({ isSocketConnected: false })),
}));

import SidebarActivityTab from '../SidebarActivityTab';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

const mockFetchWithAuth = vi.mocked(fetchWithAuth);

/**
 * Test factory for creating ActivityItem test data
 */
const createActivity = (overrides: Partial<ActivityItem> = {}): ActivityItem => ({
  id: 'activity_1',
  timestamp: new Date().toISOString(),
  operation: 'create',
  resourceType: 'page',
  resourceId: 'page_1',
  resourceTitle: 'Test Page',
  isAiGenerated: false,
  aiProvider: null,
  aiModel: null,
  aiConversationId: null,
  changeGroupId: null,
  metadata: null,
  rollbackSourceOperation: null,
  user: null,
  actorEmail: null,
  actorDisplayName: null,
  ...overrides,
});

describe('getActorDisplayName', () => {
  describe('fallback priority for actor display name', () => {
    it('should return user.name when user relation exists', () => {
      // Arrange
      const activity = createActivity({
        user: {
          id: 'user_123',
          name: 'John Doe',
          email: 'john@example.com',
          image: null,
        },
        actorDisplayName: 'John Doe (snapshot)',
        actorEmail: 'john@example.com',
      });

      // Act
      const result = getActorDisplayName(activity);

      // Assert - user.name takes priority
      expect(result).toBe('John Doe');
    });

    it('should return actorDisplayName when user is null (deleted user)', () => {
      // Arrange
      const activity = createActivity({
        user: null,
        actorDisplayName: 'Deleted User',
        actorEmail: 'deleted_user_abc123',
      });

      // Act
      const result = getActorDisplayName(activity);

      // Assert - falls back to actorDisplayName
      expect(result).toBe('Deleted User');
    });

    it('should return actorEmail when both user and actorDisplayName are null', () => {
      // Arrange
      const activity = createActivity({
        user: null,
        actorDisplayName: null,
        actorEmail: 'legacy@unknown',
      });

      // Act
      const result = getActorDisplayName(activity);

      // Assert - falls back to actorEmail
      expect(result).toBe('legacy@unknown');
    });

    it('should return "Unknown" when no actor information is available', () => {
      // Arrange
      const activity = createActivity({
        user: null,
        actorDisplayName: null,
        actorEmail: null,
      });

      // Act
      const result = getActorDisplayName(activity);

      // Assert - ultimate fallback
      expect(result).toBe('Unknown');
    });

    it('should prefer user.name over user.email when user has no name', () => {
      // Arrange - user exists but has null name
      const activity = createActivity({
        user: {
          id: 'user_123',
          name: null,
          email: 'john@example.com',
          image: null,
        },
        actorDisplayName: 'John Snapshot',
        actorEmail: 'john@example.com',
      });

      // Act
      const result = getActorDisplayName(activity);

      // Assert - falls through to actorDisplayName since user.name is null
      expect(result).toBe('John Snapshot');
    });
  });
});

describe('SidebarActivityTab (Integration)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('rendering deleted user activity', () => {
    it('should render actorDisplayName for deleted user activity', async () => {
      // Arrange - activity where user has been deleted but actorDisplayName is preserved
      const deletedUserActivity = createActivity({
        user: null,
        actorEmail: 'deleted_user_abc123',
        actorDisplayName: 'Deleted User',
      });

      mockFetchWithAuth.mockResolvedValue({
        ok: true,
        json: async () => ({
          activities: [deletedUserActivity],
          pagination: { total: 1, limit: 50, offset: 0, hasMore: false },
        }),
      } as unknown as Response);

      // Act
      render(<SidebarActivityTab />);

      // Assert - component renders the display name correctly
      await screen.findByText('Deleted User');
      expect(screen.getByText('Deleted User')).toBeInTheDocument();
    });

    it('should render AI attribution for deleted user AI activity', async () => {
      // Arrange - AI-generated activity where user has been deleted
      const aiDeletedUserActivity = createActivity({
        isAiGenerated: true,
        aiProvider: 'openai',
        aiModel: 'gpt-4',
        user: null,
        actorEmail: 'deleted_user_xyz789',
        actorDisplayName: 'Deleted User',
      });

      mockFetchWithAuth.mockResolvedValue({
        ok: true,
        json: async () => ({
          activities: [aiDeletedUserActivity],
          pagination: { total: 1, limit: 50, offset: 0, hasMore: false },
        }),
      } as unknown as Response);

      // Act
      render(<SidebarActivityTab />);

      // Assert - should show "Deleted User (via AI)"
      await screen.findByText(/Deleted User \(via AI\)/);
      expect(screen.getByText(/Deleted User \(via AI\)/)).toBeInTheDocument();
    });
  });
});
