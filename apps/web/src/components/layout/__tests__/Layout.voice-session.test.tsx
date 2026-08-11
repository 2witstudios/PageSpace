/**
 * WHERE the voice session is mounted, asserted against the REAL Layout tree.
 *
 * `VoiceSessionContext.test.tsx` proves the provider survives a child
 * unmounting — but it mounts its own provider, so it says nothing about Layout.
 * Replace `<VoiceSessionProvider>` in Layout with a passthrough and that whole
 * suite still passes, while every call in production would hang up the moment
 * the user closed the sidebar. This file is the guard for that: the provider
 * must be a real ANCESTOR of the `rightPanelVisible && …` region, in the tree
 * Layout actually renders.
 *
 * Everything heavy is mocked EXCEPT the thing under test: `VoiceSessionProvider`
 * is the real one, mounted by the real Layout. `RightPanel` is replaced by a
 * probe that CONSUMES the session, so a provider that is missing, or that has
 * been moved inside the panel, fails at render rather than subtly.
 */

import React from 'react';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useVoiceSession,
  useVoiceSessionControls,
} from '@/contexts/VoiceSessionContext';

const { layoutState, mockConnect, stopSpy, setMicSpy } = vi.hoisted(() => ({
  layoutState: {
    leftSidebarOpen: false,
    rightSidebarOpen: true,
    leftSheetOpen: false,
    rightSheetOpen: false,
    leftOverlayOpen: false,
    leftSidebarSize: '20',
    rightSidebarSize: '20',
    toggleLeftSidebar: () => {},
    toggleRightSidebar: () => {},
    setRightSidebarOpen: () => {},
    setLeftSheetOpen: () => {},
    setRightSheetOpen: () => {},
    setLeftOverlayOpen: () => {},
    setRightSidebarPageTab: () => {},
    setLeftSidebarSize: () => {},
    setRightSidebarSize: () => {},
  } as Record<string, unknown>,
  mockConnect: vi.fn(),
  stopSpy: vi.fn(),
  setMicSpy: vi.fn(),
}));

// The handshake is not what this file is about — the provider is real, the
// network is not.
vi.mock('@/lib/ai/realtime/connect', () => ({
  connectVoiceCall: mockConnect,
  VOICE_CALL_ROUTE: '/api/voice/realtime/call',
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ isLoading: false, isAuthenticated: true }),
}));
vi.mock('@/hooks/useSocket', () => ({ useSocket: () => undefined }));
vi.mock('@/hooks/useAccessRevocation', () => ({
  useAccessRevocation: () => undefined,
}));
vi.mock('@/hooks/useNotificationToasts', () => ({
  useNotificationToasts: () => undefined,
}));
vi.mock('@/hooks/useDesktopNotifications', () => ({
  useDesktopNotifications: () => undefined,
}));
vi.mock('@/hooks/useIosBadgeSync', () => ({ useIosBadgeSync: () => undefined }));
vi.mock('@/hooks/usePerformanceMonitor', () => ({
  usePerformanceMonitor: () => undefined,
}));
vi.mock('@/hooks/useIOSKeyboardInit', () => ({
  useIOSKeyboardInit: () => undefined,
}));
vi.mock('@/hooks/useMobileKeyboard', () => ({ dismissKeyboard: () => {} }));
vi.mock('@/hooks/useTabSync', () => ({ useTabSync: () => undefined }));
vi.mock('@/hooks/useHasHydrated', () => ({ useHasHydrated: () => true }));
// Desktop: neither sheet mode nor overlay mode, so `rightPanelVisible` is
// exactly `rightSidebarOpen` — the gate this test drives.
vi.mock('@/hooks/useBreakpoint', () => ({ useBreakpoint: () => false }));
vi.mock('@/hooks/useDeviceTier', () => ({
  useDeviceTier: () => ({ isTablet: false }),
}));
vi.mock('@/stores/useLayoutStore', () => ({
  useLayoutStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector(layoutState),
}));
vi.mock('@/stores/useEditingStore', () => ({
  useEditingStore: {
    getState: () => ({
      clearAllSessions: () => {},
      clearStaleSessions: () => {},
    }),
  },
}));
// `usePathname`/`useParams` are here for the real `VoiceSessionBridge` that
// Layout mounts — it is not what this file is about, but mocking it away would
// let a refactor delete it from Layout with nothing going red.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
  usePathname: () => '/dashboard/drive-1/page-1',
  useParams: () => ({ driveId: 'drive-1', pageId: 'page-1' }),
}));
vi.mock('@/hooks/useDrive', () => {
  const state = { drives: [] as unknown[], fetchDrives: () => Promise.resolve() };
  const useDriveStore = (selector: (s: typeof state) => unknown) => selector(state);
  useDriveStore.getState = () => state;
  return { useDriveStore };
});
vi.mock('@/lib/ai/shared/resolveLocationContext', () => ({
  resolveLocationContext: () => Promise.resolve({ label: null, locationContext: null }),
}));

vi.mock('@/components/layout/main-header', () => ({
  default: () => <div data-testid="top-bar" />,
}));
vi.mock('@/components/layout/left-sidebar/MemoizedSidebar', () => ({
  default: () => <div data-testid="left-sidebar" />,
}));
vi.mock('@/components/layout/middle-content/CenterPanel', () => ({
  default: () => <div data-testid="center-panel" />,
}));
vi.mock('@/components/layout/tabs', () => ({ TabBar: () => <div /> }));
vi.mock('@/components/layout/DebugPanel', () => ({ DebugPanel: () => <div /> }));
vi.mock('@/components/layout/NavigationProvider', () => ({
  NavigationProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));
vi.mock('@/contexts/GlobalChatContext', () => ({
  GlobalChatProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  useGlobalChatConversation: () => ({ currentConversationId: null }),
}));
vi.mock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ResizablePanel: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ResizableHandle: () => <div />,
}));
vi.mock('@/components/ui/sheet', () => ({
  Sheet: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SheetHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SheetTitle: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SheetDescription: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock('motion/react', () => ({
  motion: { div: ({ children }: { children: React.ReactNode }) => <div>{children}</div> },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

/**
 * Stands in for the real `RightPanel`, and consumes the voice session the way
 * the voice UI will. If `VoiceSessionProvider` is not an ancestor of this — it
 * was deleted, made a passthrough, or moved INSIDE the panel — these hooks
 * throw and every test in this file goes red.
 */
vi.mock('@/components/layout/right-sidebar', () => {
  // Named and capitalised so it is a component to the rules-of-hooks lint, not
  // an anonymous `default` that happens to call hooks.
  const RightPanelProbe = () => {
    const { status, callId } = useVoiceSession();
    const { start } = useVoiceSessionControls();
    return (
      <button
        type="button"
        data-testid="right-panel"
        data-call={callId ?? ''}
        onClick={() =>
          void start({ conversationId: 'conv-layout', type: 'global' })
        }
      >
        {status}
      </button>
    );
  };
  return { default: RightPanelProbe };
});

import Layout from '../Layout';

/** Rendered as Layout's children — inside the tree, outside the sidebar gate. */
const seen: { status?: string; callId?: string | null } = {};
function PersistentProbe() {
  const { status, callId } = useVoiceSession();
  seen.status = status;
  seen.callId = callId;
  return <div data-testid="persistent" />;
}

beforeEach(() => {
  vi.clearAllMocks();
  layoutState.rightSidebarOpen = true;
  mockConnect.mockResolvedValue({
    ok: true,
    connection: {
      callId: 'rtc_layout_call',
      attached: true,
      // No cap reported: this file is about placement, not chaining, and a
      // chain timer would only add a way for it to be flaky.
      maxDurationMs: undefined,
      microphone: { getTracks: () => [], getAudioTracks: () => [] },
      setMicrophoneEnabled: setMicSpy,
      stop: stopSpy,
    },
  });
});

describe('Layout — where the voice session is mounted', () => {
  it('should render the sidebar panel INSIDE the voice session', () => {
    // The panel reads the session directly. Rendering at all is the assertion:
    // a missing or passthrough provider throws out of these hooks.
    const view = render(
      <Layout>
        <PersistentProbe />
      </Layout>,
    );

    expect(view.getByTestId('right-panel').textContent).toBe('idle');
    expect(seen.status).toBe('idle');
  });

  it('given the sidebar closes mid-call, should keep the call alive', async () => {
    // The whole reason the provider sits above the panel group. Started from
    // inside the panel, the way the real trigger will be.
    const view = render(
      <Layout>
        <PersistentProbe />
      </Layout>,
    );

    await act(async () => {
      view.getByTestId('right-panel').click();
    });
    expect(seen.status).toBe('connected');
    expect(seen.callId).toBe('rtc_layout_call');

    // Close the sidebar: `rightPanelVisible` goes false and the panel unmounts.
    layoutState.rightSidebarOpen = false;
    await act(async () => {
      view.rerender(
        <Layout>
          <PersistentProbe />
        </Layout>,
      );
    });

    expect(view.queryByTestId('right-panel')).toBeNull();
    expect(stopSpy).not.toHaveBeenCalled();
    expect(seen.status).toBe('connected');
    expect(seen.callId).toBe('rtc_layout_call');
  });

  it('given the sidebar reopens, should find the same call still running', async () => {
    const view = render(
      <Layout>
        <PersistentProbe />
      </Layout>,
    );
    await act(async () => {
      view.getByTestId('right-panel').click();
    });

    layoutState.rightSidebarOpen = false;
    await act(async () => {
      view.rerender(
        <Layout>
          <PersistentProbe />
        </Layout>,
      );
    });

    layoutState.rightSidebarOpen = true;
    await act(async () => {
      view.rerender(
        <Layout>
          <PersistentProbe />
        </Layout>,
      );
    });

    // One call for the whole cycle — reopening did not start a second.
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(view.getByTestId('right-panel').dataset.call).toBe('rtc_layout_call');
    expect(view.getByTestId('right-panel').textContent).toBe('connected');
  });
});
