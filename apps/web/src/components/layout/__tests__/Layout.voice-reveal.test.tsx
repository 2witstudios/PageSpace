/**
 * Two structural guarantees about Layout that no behavioural test elsewhere can
 * hold, asserted against the tree Layout actually renders:
 *
 *  1. `VoiceSessionBridge` is MOUNTED. It renders nothing, so deleting it is
 *     invisible: navigation would silently stop updating a live call's sense of
 *     place, and the agent switcher would silently stop moving calls. Both
 *     failures are quiet and both are the feature.
 *  2. Revealing the assistant OPENS and never CLOSES. `Layout` owns the
 *     breakpoint facts, so this is the only place the wiring from the pure
 *     `decideReveal` to the actual store writes can be checked.
 *
 * Everything heavy is mocked; the bridge and the reveal handler are real.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { layoutState, writes, revealFromTopBar } = vi.hoisted(() => ({
  layoutState: {} as Record<string, unknown>,
  writes: [] as Array<[string, unknown]>,
  revealFromTopBar: { fire: (_surface: string) => {} },
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ isLoading: false, isAuthenticated: true }),
}));
vi.mock('@/hooks/useSocket', () => ({ useSocket: () => undefined }));
vi.mock('@/hooks/useAccessRevocation', () => ({ useAccessRevocation: () => undefined }));
vi.mock('@/hooks/useNotificationToasts', () => ({ useNotificationToasts: () => undefined }));
vi.mock('@/hooks/useDesktopNotifications', () => ({ useDesktopNotifications: () => undefined }));
vi.mock('@/hooks/useIosBadgeSync', () => ({ useIosBadgeSync: () => undefined }));
vi.mock('@/hooks/usePerformanceMonitor', () => ({ usePerformanceMonitor: () => undefined }));
vi.mock('@/hooks/useIOSKeyboardInit', () => ({ useIOSKeyboardInit: () => undefined }));
vi.mock('@/hooks/useMobileKeyboard', () => ({ dismissKeyboard: () => {} }));
vi.mock('@/hooks/useTabSync', () => ({ useTabSync: () => undefined }));
vi.mock('@/hooks/useHasHydrated', () => ({ useHasHydrated: () => true }));
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

// The bridge renders nothing, so it is given a visible probe here — that is the
// only way "is it mounted" can be asserted at all.
vi.mock('@/components/ai/voice/realtime', () => ({
  VoiceSessionBridge: () => <div data-testid="voice-session-bridge" />,
  VoiceNavTrigger: () => <div />,
  VoiceCallBar: () => <div />,
}));

vi.mock('@/components/layout/main-header', () => ({
  default: ({ onRevealAssistant }: { onRevealAssistant: (surface: string) => void }) => {
    revealFromTopBar.fire = onRevealAssistant;
    return <div data-testid="top-bar" />;
  },
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

/**
 * Layout writes to the layout store on mount (breakpoint reconciliation), so
 * every assertion below is about what the REVEAL wrote — the log is cleared
 * once the tree has settled.
 */
const renderAndReveal = (surface: 'sidebar' | 'dashboard') => {
  const view = render(
    <Layout>
      <div />
    </Layout>,
  );
  writes.length = 0;
  revealFromTopBar.fire(surface);
  return view;
};

const record = (key: string) => (value: unknown) => {
  writes.push([key, value]);
  layoutState[key] = value;
};

beforeEach(() => {
  writes.length = 0;
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
    toggleRightSidebar: () => record('rightSidebarOpen')('TOGGLED'),
    setRightSidebarOpen: record('rightSidebarOpen'),
    setLeftSheetOpen: record('leftSheetOpen'),
    setRightSheetOpen: record('rightSheetOpen'),
    setLeftOverlayOpen: record('leftOverlayOpen'),
    setRightSidebarPageTab: record('rightSidebarPageTab'),
    setLeftSidebarSize: () => {},
    setRightSidebarSize: () => {},
  });
});

describe('Layout — the voice bridge', () => {
  it('should mount the bridge, which renders nothing and would vanish silently', () => {
    render(
      <Layout>
        <div />
      </Layout>,
    );
    expect(screen.getByTestId('voice-session-bridge')).toBeInTheDocument();
  });
});

describe('Layout — revealing the assistant', () => {
  it('should open the sidebar and bring the chat tab forward', () => {
    renderAndReveal('sidebar');

    expect(writes).toContainEqual(['rightSidebarOpen', true]);
    // Voice is a mode on the CHAT surface, so it must not land on whatever tab
    // the sidebar was left showing.
    expect(writes).toContainEqual(['rightSidebarPageTab', 'chat']);
  });

  it('should never close an already-open sidebar, and never route through the toggle', () => {
    layoutState.rightSidebarOpen = true;
    renderAndReveal('sidebar');

    // The failure this guards: pressing the live indicator hides the call.
    expect(writes).not.toContainEqual(['rightSidebarOpen', false]);
    expect(writes).not.toContainEqual(['rightSidebarOpen', 'TOGGLED']);
  });

  it('should open nothing on the dashboard, where the call renders in the centre', () => {
    renderAndReveal('dashboard');

    expect(writes).toHaveLength(0);
  });
});
