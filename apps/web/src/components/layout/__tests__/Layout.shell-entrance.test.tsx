/**
 * The shell entrance animation must fire on a cold boot and NEVER on ordinary
 * navigation.
 *
 * The distinction is not obvious from `Layout` alone, which is why this test
 * exists. Three sibling layout clients — DashboardLayoutClient,
 * SettingsLayoutClient and NotificationsLayoutClient — each mount their OWN
 * `Layout`. Moving between /dashboard, /settings and /notifications therefore
 * unmounts one `Layout` and mounts another, so "the shell mounted" is emphatically
 * not the same event as "the app booted". An earlier version applied the class
 * unconditionally and faded the whole shell out and back in every time the user
 * opened settings.
 *
 * What actually separates the two cases is whether THIS mount rendered the boot
 * screen: a cold boot always does (the layout store has not rehydrated yet), and
 * a navigation mount never does (it is already hydrated and authenticated).
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { layoutState, auth, hydration } = vi.hoisted(() => ({
  layoutState: {} as Record<string, unknown>,
  auth: { isLoading: false, isAuthenticated: true },
  hydration: { hasHydrated: true },
}));

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth }));
vi.mock('@/hooks/useHasHydrated', () => ({ useHasHydrated: () => hydration.hasHydrated }));
vi.mock('@/hooks/useSocket', () => ({ useSocket: () => undefined }));
vi.mock('@/hooks/useAccessRevocation', () => ({ useAccessRevocation: () => undefined }));
vi.mock('@/hooks/useNotificationToasts', () => ({ useNotificationToasts: () => undefined }));
vi.mock('@/hooks/useDesktopNotifications', () => ({ useDesktopNotifications: () => undefined }));
vi.mock('@/hooks/useNativeBadgeSync', () => ({ useNativeBadgeSync: () => undefined }));
vi.mock('@/hooks/usePerformanceMonitor', () => ({ usePerformanceMonitor: () => undefined }));
vi.mock('@/hooks/useIOSKeyboardInit', () => ({ useIOSKeyboardInit: () => undefined }));
vi.mock('@/hooks/useMobileKeyboard', () => ({ dismissKeyboard: () => {} }));
vi.mock('@/hooks/useTabSync', () => ({ useTabSync: () => undefined }));
vi.mock('@/hooks/useBreakpoint', () => ({ useBreakpoint: () => false }));
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
  VoiceSessionBridge: () => <div />,
  VoiceNavTrigger: () => <div />,
  VoiceCallBar: () => <div />,
}));
vi.mock('@/components/layout/main-header', () => ({
  default: () => <div data-testid="top-bar" />,
}));
vi.mock('@/components/layout/left-sidebar/MemoizedSidebar', () => ({ default: () => <div /> }));
vi.mock('@/components/layout/middle-content/CenterPanel', () => ({ default: () => <div /> }));
vi.mock('@/components/layout/right-sidebar', () => ({ default: () => <div /> }));
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
vi.mock('@/components/ui/sheet', () => ({
  Sheet: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('motion/react', () => ({
  motion: { div: ({ children }: { children: React.ReactNode }) => <div>{children}</div> },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import Layout from '../Layout';

/** The shell root is the element carrying the app-height style. */
const shellRoot = () => screen.getByTestId('top-bar').parentElement as HTMLElement;

const renderShell = () =>
  render(
    <Layout>
      <div />
    </Layout>,
  );

beforeEach(() => {
  auth.isLoading = false;
  auth.isAuthenticated = true;
  hydration.hasHydrated = true;
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

describe('Layout — the shell entrance animation', () => {
  it('should NOT animate when a mount goes straight to the shell, as navigation between layout clients does', () => {
    // Already hydrated and authenticated: exactly the state a fresh Layout sees
    // when the user moves from /dashboard to /settings. The boot screen never
    // renders, so the entrance must not either.
    renderShell();

    expect(shellRoot()).not.toHaveClass('app-shell-enter');
  });

  it('should animate when the mount rendered the boot screen first', () => {
    // Cold boot: the layout store has not rehydrated, so Layout returns the
    // spinner on its first render.
    hydration.hasHydrated = false;
    const { rerender } = renderShell();
    expect(screen.queryByTestId('top-bar')).not.toBeInTheDocument();

    // Rehydration completes and the gate opens — the shell arrives.
    hydration.hasHydrated = true;
    rerender(
      <Layout>
        <div />
      </Layout>,
    );

    expect(shellRoot()).toHaveClass('app-shell-enter');
  });

  it('should keep the shell classes intact whether or not it animates', () => {
    renderShell();
    // The entrance is prepended to an existing className; a bad interpolation
    // would silently drop the layout classes and break the shell outright.
    expect(shellRoot()).toHaveClass('flex', 'flex-col', 'overflow-hidden');
  });
});
