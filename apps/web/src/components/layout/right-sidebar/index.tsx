"use client";

import { useState, useEffect, useRef, memo, useCallback } from "react";
import { useParams } from "next/navigation";
import { History, MessageSquare, Activity, TerminalSquare } from "lucide-react";

import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { useSidebarAgentStore } from "@/hooks/page-agents";
import { useDashboardContext } from "@/hooks/useDashboardContext";
import { usePageAgentDashboardStore, type SidebarTab } from "@/stores/page-agents";
import { useTabsStore, type Tab } from "@/stores/useTabsStore";
import { useLayoutStore } from "@/stores/useLayoutStore";
import { useTabMeta } from "@/hooks/useTabMeta";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useMobileKeyboard } from "@/hooks/useMobileKeyboard";
import { PageType } from "@pagespace/lib/utils/enums";

import SidebarChatTab from "./ai-assistant/SidebarChatTab";
import SidebarHistoryTab from "./ai-assistant/SidebarHistoryTab";
import SidebarActivityTab from "./ai-assistant/SidebarActivityTab";
import TerminalNavigatorTab from "./TerminalNavigatorTab";

export interface RightPanelProps {
  className?: string;
  variant?: "desktop" | "overlay";
}

// Stable placeholder passed to useTabMeta when there's no active tab (e.g.
// dashboard context) — useTabMeta must be called unconditionally (rules of
// hooks), and an empty path resolves to its inert "unknown" fallback branch
// with no fetch triggered.
const NO_ACTIVE_TAB: Tab = { id: '', path: '', history: [], historyIndex: 0, isPinned: false };

/**
 * Right sidebar panel - contains AI Assistant chat, history, and activity.
 *
 * TAB STATE MANAGEMENT:
 * - Dashboard context: Uses usePageAgentDashboardStore.activeTab (synced with GlobalAssistantView)
 * - Page context: Uses local state (independent from page content)
 *
 * AGENT STATE MANAGEMENT:
 * - Dashboard context: Uses usePageAgentDashboardStore.selectedAgent (shared with GlobalAssistantView)
 * - Page context: Uses useSidebarAgentStore.selectedAgent (independent sidebar chat)
 *
 * ACCESSIBILITY:
 * - Uses Radix UI Tabs for keyboard navigation (Arrow keys, Home, End)
 * - Automatic ARIA roles (tablist, tab, tabpanel)
 * - Focus management and screen reader support
 */
function RightPanel({ className, variant }: RightPanelProps) {
  const { isDashboardContext } = useDashboardContext();
  const params = useParams();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  // Mobile keyboard support - adjust height when keyboard is open
  const { isOpen: isKeyboardOpen, height: keyboardHeight } = useMobileKeyboard();

  // Get agent state from both stores (hooks must be called unconditionally)
  // Only extract selectedAgent from sidebar state to minimize subscriptions
  const sidebarAgent = useSidebarAgentStore((state) => state.selectedAgent);
  const dashboardAgent = usePageAgentDashboardStore((state) => state.selectedAgent);
  const dashboardActiveTab = usePageAgentDashboardStore((state) => state.activeTab);
  const setDashboardActiveTab = usePageAgentDashboardStore((state) => state.setActiveTab);
  const rightSidebarOpen = useLayoutStore((state) => state.rightSidebarOpen);

  // On dashboard context, use the central agent store; otherwise use sidebar's own store
  const selectedAgent = isDashboardContext ? dashboardAgent : sidebarAgent;

  // Chat tab is only shown when NOT on dashboard context
  const showChatTab = !isDashboardContext;

  // Terminal tab is only shown while the active page is a Terminal page AND
  // the user is an admin — TerminalWorkspace (the middle-content component
  // that actually creates the pane workspace) is itself admin-gated, so a
  // non-admin Terminal tab here would be all dead clicks. `useTabMeta` is
  // called directly (not just read off the cached tab) so the fetch that
  // resolves `pageType` is triggered from here too, not only from whichever
  // TabItem happens to be mounted in the tab bar — narrowing the window
  // where a freshly-opened Terminal page's tab hasn't resolved its type yet.
  const activeTabItem = useTabsStore((state) => state.selectActiveTab(state));
  const activeTabMeta = useTabMeta(activeTabItem ?? NO_ACTIVE_TAB);
  const showTerminalTab = isAdmin && activeTabMeta.pageType === PageType.TERMINAL;
  const activeTerminalPageId = showTerminalTab ? (params.pageId as string | undefined) : undefined;

  // Local tab state for page context (independent from dashboard)
  const [localActiveTab, setLocalActiveTab] = useState<SidebarTab>(showChatTab ? "chat" : "history");

  // Auto-switch to chat tab when navigating from dashboard to page context
  // This ensures streaming continues visibly in the sidebar
  // Also transfer agent state from dashboard to sidebar for seamless conversation handoff
  const prevIsDashboardContext = useRef(isDashboardContext);
  useEffect(() => {
    // Only switch when transitioning FROM dashboard TO page context
    if (prevIsDashboardContext.current && !isDashboardContext) {
      setLocalActiveTab('chat');

      // Transfer agent state from dashboard to sidebar for seamless handoff
      const dashboardState = usePageAgentDashboardStore.getState();
      if (dashboardState.selectedAgent) {
        useSidebarAgentStore.getState().transferFromDashboard({
          agent: dashboardState.selectedAgent,
          conversationId: dashboardState.conversationId,
          messages: dashboardState.conversationMessages,
        });
      }
    }
    prevIsDashboardContext.current = isDashboardContext;
  }, [isDashboardContext]);

  // Default the sidebar to the Terminal tab whenever a Terminal page becomes
  // active while the sidebar is open, OR the sidebar is opened while already
  // on a Terminal page (e.g. navigate to a Terminal page with the sidebar
  // closed, then open it) — both are "a Terminal page just became visible
  // with the sidebar open" from the user's perspective. Forcing the switch
  // on every render where both happen to be true would fight the user's own
  // tab clicks, so it only fires on the transition into that state, tracked
  // via both refs. When navigating away from a Terminal page, fall back off
  // the now-hidden tab.
  const prevTerminalPageId = useRef<string | undefined>(undefined);
  const prevRightSidebarOpen = useRef(rightSidebarOpen);
  useEffect(() => {
    const pageIdChanged = activeTerminalPageId !== prevTerminalPageId.current;
    const sidebarJustOpened = rightSidebarOpen && !prevRightSidebarOpen.current;
    if (activeTerminalPageId && rightSidebarOpen && (pageIdChanged || sidebarJustOpened)) {
      setLocalActiveTab('terminal');
    } else if (!activeTerminalPageId && prevTerminalPageId.current) {
      setLocalActiveTab((tab) => (tab === 'terminal' ? 'chat' : tab));
    }
    prevTerminalPageId.current = activeTerminalPageId;
    prevRightSidebarOpen.current = rightSidebarOpen;
  }, [activeTerminalPageId, rightSidebarOpen]);

  // Use appropriate tab state based on context
  const activeTab = isDashboardContext ? dashboardActiveTab : localActiveTab;

  const handleTabChange = useCallback((tab: string) => {
    const validTab = tab as SidebarTab;
    if (isDashboardContext) {
      setDashboardActiveTab(validTab);
    } else {
      setLocalActiveTab(validTab);
    }
  }, [isDashboardContext, setDashboardActiveTab]);

  // Shared trigger styles matching original visual design
  const triggerBaseStyles = cn(
    "relative flex items-center justify-center gap-1 rounded-md px-2 py-2 transition-colors",
    "text-xs font-medium sm:text-sm",
    "data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm",
    "data-[state=inactive]:text-muted-foreground data-[state=inactive]:hover:bg-muted/60 data-[state=inactive]:hover:text-foreground"
  );

  // For overlay variant (Sheet on mobile), adjust height when keyboard is open
  const isOverlay = variant === 'overlay';
  const adjustedHeight = isOverlay && isKeyboardOpen
    ? `calc(100% - ${keyboardHeight}px)`
    : undefined;

  return (
    <aside
      className={cn(
        "flex w-full flex-col pt-[env(safe-area-inset-top)] text-sidebar-foreground liquid-glass-regular rounded-tl-lg border border-[var(--separator)] shadow-[var(--shadow-elevated)] dark:shadow-none overflow-hidden",
        // Use h-full normally, but allow height override when keyboard is open
        !adjustedHeight && "h-full",
        // Only add bottom padding when keyboard is NOT open
        !isKeyboardOpen && "pb-[env(safe-area-inset-bottom)]",
        className,
      )}
      style={{
        height: adjustedHeight,
      }}
    >
      <Tabs
        value={activeTab}
        onValueChange={handleTabChange}
        className="flex h-full w-full flex-col"
      >
        <div className="border-b border-[var(--separator)]">
          <TabsList
            className={cn(
              "grid gap-1 px-1 py-1 w-full h-auto bg-transparent rounded-none",
              showTerminalTab ? "grid-cols-4" : showChatTab ? "grid-cols-3" : "grid-cols-2"
            )}
          >
            {showChatTab && (
              <TabsTrigger
                value="chat"
                className={triggerBaseStyles}
              >
                <MessageSquare className="h-4 w-4" />
                <span className="hidden @[180px]:inline">Chat</span>
                <div
                  className={cn(
                    "absolute bottom-0 left-1/2 h-0.5 w-1/2 -translate-x-1/2 bg-primary transition-opacity",
                    activeTab === "chat" ? "opacity-100" : "opacity-0"
                  )}
                />
              </TabsTrigger>
            )}

            <TabsTrigger
              value="history"
              className={triggerBaseStyles}
            >
              <History className="h-4 w-4" />
              <span className="hidden @[180px]:inline">History</span>
              <div
                className={cn(
                  "absolute bottom-0 left-1/2 h-0.5 w-1/2 -translate-x-1/2 bg-primary transition-opacity",
                  activeTab === "history" ? "opacity-100" : "opacity-0"
                )}
              />
            </TabsTrigger>

            <TabsTrigger
              value="activity"
              className={triggerBaseStyles}
            >
              <Activity className="h-4 w-4" />
              <span className="hidden @[180px]:inline">Activity</span>
              <div
                className={cn(
                  "absolute bottom-0 left-1/2 h-0.5 w-1/2 -translate-x-1/2 bg-primary transition-opacity",
                  activeTab === "activity" ? "opacity-100" : "opacity-0"
                )}
              />
            </TabsTrigger>

            {showTerminalTab && (
              <TabsTrigger
                value="terminal"
                className={triggerBaseStyles}
              >
                <TerminalSquare className="h-4 w-4" />
                <span className="hidden @[180px]:inline">Terminal</span>
                <div
                  className={cn(
                    "absolute bottom-0 left-1/2 h-0.5 w-1/2 -translate-x-1/2 bg-primary transition-opacity",
                    activeTab === "terminal" ? "opacity-100" : "opacity-0"
                  )}
                />
              </TabsTrigger>
            )}
          </TabsList>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {/*
            Keep all tabs mounted to preserve state (chat history, scroll position, etc).
            Use CSS visibility/display to hide inactive tabs.
            TabsContent with forceMount keeps them in DOM but we control visibility.
          */}
          {showChatTab && (
            <TabsContent
              value="chat"
              forceMount
              className={cn(
                "h-full m-0 outline-none",
                activeTab === "chat" ? "flex flex-col" : "hidden"
              )}
            >
              <SidebarChatTab />
            </TabsContent>
          )}
          <TabsContent
            value="history"
            forceMount
            className={cn(
              "h-full m-0 outline-none",
              activeTab === "history" ? "flex flex-col" : "hidden"
            )}
          >
            <SidebarHistoryTab
              selectedAgent={selectedAgent}
              isDashboardContext={isDashboardContext}
            />
          </TabsContent>
          <TabsContent
            value="activity"
            forceMount
            className={cn(
              "h-full m-0 outline-none",
              activeTab === "activity" ? "flex flex-col" : "hidden"
            )}
          >
            <SidebarActivityTab />
          </TabsContent>

          {showTerminalTab && activeTerminalPageId && (
            <TabsContent
              value="terminal"
              forceMount
              className={cn(
                "h-full m-0 outline-none",
                activeTab === "terminal" ? "flex flex-col" : "hidden"
              )}
            >
              <TerminalNavigatorTab terminalId={activeTerminalPageId} />
            </TabsContent>
          )}
        </div>
      </Tabs>
    </aside>
  );
}

export default memo(RightPanel);
