/**
 * Where focus lands when a mobile side panel opens.
 *
 * Radix Dialog focuses the first tabbable descendant on open. In the left sheet
 * that is the sidebar search input (the drive switcher is a Skeleton while drives
 * load), and on iOS/Capacitor a programmatically focused input raises the keyboard
 * over the panel the user just opened. Layout cancels that auto-focus — but it
 * must still move focus INTO the sheet, or keyboard and screen-reader users are
 * left on the toolbar behind a modal. Both halves are asserted here against the
 * real Sheet; everything else is mocked.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { layoutState } = vi.hoisted(() => ({
  layoutState: {} as Record<string, unknown>,
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ isLoading: false, isAuthenticated: true }),
}));
vi.mock('@/hooks/useSocket', () => ({ useSocket: () => undefined }));
vi.mock('@/hooks/useAccessRevocation', () => ({ useAccessRevocation: () => undefined }));
vi.mock('@/hooks/useNotificationToasts', () => ({ useNotificationToasts: () => undefined }));
vi.mock('@/hooks/useDesktopNotifications', () => ({ useDesktopNotifications: () => undefined }));
vi.mock('@/hooks/useNativeBadgeSync', () => ({ useNativeBadgeSync: () => undefined }));
vi.mock('@/hooks/usePerformanceMonitor', () => ({ usePerformanceMonitor: () => undefined }));
vi.mock('@/hooks/useIOSKeyboardInit', () => ({ useIOSKeyboardInit: () => undefined }));
vi.mock('@/hooks/useMobileKeyboard', () => ({ dismissKeyboard: () => {} }));
vi.mock('@/hooks/useTabSync', () => ({ useTabSync: () => undefined }));
vi.mock('@/hooks/useHasHydrated', () => ({ useHasHydrated: () => true }));
// Every media query matches: this is the phone layout.
vi.mock('@/hooks/useBreakpoint', () => ({ useBreakpoint: () => true }));
vi.mock('@/hooks/useDeviceTier', () => ({ useDeviceTier: () => ({ isTablet: false }) }));

vi.mock('@/stores/useLayoutStore', () => ({
  useLayoutStore: (selector: (state: Record<string, unknown>) => unknown) => selector(layoutState),
}));
vi.mock('@/stores/useEditingStore', () => ({
  useEditingStore: {
    getState: () => ({ clearAllSessions: () => {}, clearStaleSessions: () => {} }),
  },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
  usePathname: () => '/dashboard/drive-1/page-1',
  useParams: () => ({ driveId: 'drive-1', pageId: 'page-1' }),
}));
vi.mock('@/components/ai/voice/realtime', () => ({
  VoiceSessionBridge: () => null,
  VoiceNavTrigger: () => <div />,
  VoiceCallBar: () => <div />,
}));
vi.mock('@/components/layout/main-header', () => ({
  default: () => <div data-testid="top-bar" />,
}));
// The sidebar as the first tabbable thing Radix would find: a search input.
vi.mock('@/components/layout/left-sidebar/MemoizedSidebar', () => ({
  default: () => <input placeholder="Search pages..." />,
}));
vi.mock('@/components/layout/middle-content/CenterPanel', () => ({ default: () => <div /> }));
vi.mock('@/components/layout/right-sidebar', () => ({
  default: () => <textarea placeholder="Message the assistant" />,
}));
vi.mock('@/components/layout/tabs', () => ({ TabBar: () => <div /> }));
vi.mock('@/components/layout/DebugPanel', () => ({ DebugPanel: () => <div /> }));
vi.mock('@/components/layout/NavigationProvider', () => ({
  NavigationProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/contexts/GlobalChatContext', () => ({
  GlobalChatProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useGlobalChatConversation: () => ({ currentConversationId: null }),
}));
vi.mock('@/contexts/VoiceSessionContext', () => ({
  VoiceSessionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => <div />,
}));
vi.mock('motion/react', () => ({
  motion: { div: ({ children }: { children: React.ReactNode }) => <div>{children}</div> },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import Layout from '../Layout';

beforeEach(() => {
  Object.assign(layoutState, {
    leftSidebarOpen: false,
    rightSidebarOpen: false,
    leftSheetOpen: false,
    rightSheetOpen: false,
    leftOverlayOpen: false,
    rightSidebarPageTab: 'history',
    leftSidebarSize: 20,
    rightSidebarSize: 20,
    toggleLeftSidebar: () => {},
    toggleRightSidebar: () => {},
    setRightSidebarOpen: () => {},
    setLeftSheetOpen: () => {},
    setRightSheetOpen: () => {},
    setLeftOverlayOpen: () => {},
    setRightSidebarPageTab: () => {},
    setLeftSidebarSize: () => {},
    setRightSidebarSize: () => {},
  });
});

const renderOpen = (which: 'leftSheetOpen' | 'rightSheetOpen') => {
  layoutState[which] = true;
  render(
    <Layout>
      <div />
    </Layout>,
  );
};

describe('Layout — focus when a mobile sheet opens', () => {
  it('should not focus the sidebar search input, which would raise the keyboard', () => {
    renderOpen('leftSheetOpen');

    const input = screen.getByPlaceholderText('Search pages...');
    expect(document.activeElement).not.toBe(input);
  });

  it('should still move focus into the navigation sheet, not leave it on the page behind', () => {
    renderOpen('leftSheetOpen');

    const dialog = screen.getByRole('dialog', { name: 'Navigation menu' });
    expect(document.activeElement).toBe(dialog);
  });

  it('should treat the assistant sheet the same way', () => {
    renderOpen('rightSheetOpen');

    const dialog = screen.getByRole('dialog', { name: 'Global Assistant panel' });
    expect(document.activeElement).toBe(dialog);
    expect(document.activeElement).not.toBe(screen.getByPlaceholderText('Message the assistant'));
  });
});
