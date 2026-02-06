/**
 * PageViewers Component Tests
 * Tests for the stacked avatar display showing who is viewing a page.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { PresenceViewer } from '@/lib/websocket';

// Hoist mocks
const { mockUseAuth, mockPresenceStore } = vi.hoisted(() => ({
  mockUseAuth: vi.fn(),
  mockPresenceStore: new Map<string, PresenceViewer[]>(),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => mockUseAuth(),
}));

vi.mock('@/stores/usePresenceStore', () => ({
  usePresenceStore: (selector: (state: { pageViewers: Map<string, PresenceViewer[]> }) => unknown) => {
    return selector({ pageViewers: mockPresenceStore });
  },
}));

// Radix tooltip portals to document.body - mock to render inline for testing
vi.mock('@radix-ui/react-tooltip', () => ({
  Provider: ({ children }: { children: React.ReactNode }) => children,
  Root: ({ children }: { children: React.ReactNode }) => children,
  Trigger: ({ children, asChild, ...props }: { children: React.ReactNode; asChild?: boolean }) => (
    <span {...props}>{children}</span>
  ),
  Content: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Portal: ({ children }: { children: React.ReactNode }) => children,
  Arrow: () => null,
}));

import { PageViewers, PageViewersInline } from '../PageViewers';

const createViewer = (overrides: Partial<PresenceViewer> = {}): PresenceViewer => ({
  userId: 'user-1',
  socketId: 'socket-1',
  name: 'Alice Smith',
  avatarUrl: null,
  ...overrides,
});

describe('PageViewers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPresenceStore.clear();
    mockUseAuth.mockReturnValue({ user: { id: 'current-user' } });
  });

  describe('rendering', () => {
    it('given no viewers, should render nothing', () => {
      const { container } = render(<PageViewers pageId="page-1" />);

      expect(container.innerHTML).toBe('');
    });

    it('given no pageId, should render nothing', () => {
      const { container } = render(<PageViewers pageId={null} />);

      expect(container.innerHTML).toBe('');
    });

    it('given only the current user as viewer, should render nothing', () => {
      mockPresenceStore.set('page-1', [createViewer({ userId: 'current-user', name: 'Me' })]);

      const { container } = render(<PageViewers pageId="page-1" />);

      expect(container.innerHTML).toBe('');
    });

    it('given other viewers, should render avatar group', () => {
      mockPresenceStore.set('page-1', [
        createViewer({ userId: 'user-2', name: 'Bob Jones' }),
      ]);

      render(<PageViewers pageId="page-1" />);

      const group = screen.getByRole('group');
      expect(group).toHaveAttribute('aria-label', 'People viewing this page');
    });

    it('given multiple other viewers, should render initials for each', () => {
      mockPresenceStore.set('page-1', [
        createViewer({ userId: 'user-2', socketId: 'socket-2', name: 'Bob Jones' }),
        createViewer({ userId: 'user-3', socketId: 'socket-3', name: 'Carol' }),
      ]);

      render(<PageViewers pageId="page-1" />);

      expect(screen.getByText('BJ')).toBeInTheDocument();
      expect(screen.getByText('C')).toBeInTheDocument();
    });

    it('given viewers including current user, should filter out current user', () => {
      mockPresenceStore.set('page-1', [
        createViewer({ userId: 'current-user', name: 'Me' }),
        createViewer({ userId: 'user-2', socketId: 'socket-2', name: 'Bob' }),
      ]);

      render(<PageViewers pageId="page-1" />);

      expect(screen.getByText('B')).toBeInTheDocument();
      expect(screen.queryByText('M')).not.toBeInTheDocument();
    });
  });

  describe('overflow counter', () => {
    it('given more viewers than maxVisible, should show +N counter', () => {
      mockPresenceStore.set('page-1', [
        createViewer({ userId: 'u1', socketId: 's1', name: 'A' }),
        createViewer({ userId: 'u2', socketId: 's2', name: 'B' }),
        createViewer({ userId: 'u3', socketId: 's3', name: 'C' }),
      ]);

      render(<PageViewers pageId="page-1" maxVisible={2} />);

      expect(screen.getByText('+1')).toBeInTheDocument();
    });

    it('given viewers within maxVisible limit, should not show counter', () => {
      mockPresenceStore.set('page-1', [
        createViewer({ userId: 'u1', socketId: 's1', name: 'A' }),
        createViewer({ userId: 'u2', socketId: 's2', name: 'B' }),
      ]);

      render(<PageViewers pageId="page-1" maxVisible={4} />);

      expect(screen.queryByText(/\+\d/)).not.toBeInTheDocument();
    });
  });
});

describe('PageViewersInline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPresenceStore.clear();
    mockUseAuth.mockReturnValue({ user: { id: 'current-user' } });
  });

  it('given no viewers, should render nothing', () => {
    const { container } = render(<PageViewersInline pageId="page-1" />);

    expect(container.innerHTML).toBe('');
  });

  it('given other viewers, should render compact avatars', () => {
    mockPresenceStore.set('page-1', [
      createViewer({ userId: 'user-2', name: 'Bob' }),
    ]);

    render(<PageViewersInline pageId="page-1" />);

    expect(screen.getByText('B')).toBeInTheDocument();
  });

  it('given overflow beyond maxVisible, should show +N counter', () => {
    mockPresenceStore.set('page-1', [
      createViewer({ userId: 'u1', socketId: 's1', name: 'A' }),
      createViewer({ userId: 'u2', socketId: 's2', name: 'B' }),
      createViewer({ userId: 'u3', socketId: 's3', name: 'C' }),
      createViewer({ userId: 'u4', socketId: 's4', name: 'D' }),
    ]);

    render(<PageViewersInline pageId="page-1" maxVisible={2} />);

    expect(screen.getByText('+2')).toBeInTheDocument();
  });
});
