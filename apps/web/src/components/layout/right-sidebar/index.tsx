"use client";

import { useState } from "react";
import { History, MessageSquare, Settings } from "lucide-react";

import { cn } from "@/lib/utils";
import { useSidebarAgentState } from "@/hooks/useSidebarAgentState";
import { useDashboardContext } from "@/hooks/useDashboardContext";
import { useAgentStore, type SidebarTab } from "@/stores/useAgentStore";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

import AssistantChatTab from "./ai-assistant/AssistantChatTab";
import AssistantHistoryTab from "./ai-assistant/AssistantHistoryTab";
import AssistantSettingsTab from "./ai-assistant/AssistantSettingsTab";

export interface RightPanelProps {
  className?: string;
  variant?: "desktop" | "overlay";
}

/**
 * Right sidebar panel - contains AI Assistant chat, history, and settings.
 *
 * TAB STATE MANAGEMENT:
 * - Dashboard context: Uses useAgentStore.activeTab (synced with GlobalAssistantView)
 * - Page context: Uses local state (independent from page content)
 *
 * AGENT STATE MANAGEMENT:
 * - Dashboard context: Uses useAgentStore.selectedAgent (shared with GlobalAssistantView)
 * - Page context: Uses useSidebarAgentState (independent sidebar chat)
 *
 * ACCESSIBILITY:
 * - Uses Radix UI Tabs for keyboard navigation (Arrow keys, Home, End)
 * - Automatic ARIA roles (tablist, tab, tabpanel)
 * - Focus management and screen reader support
 */
export default function RightPanel({ className }: RightPanelProps) {
  const { isDashboardContext } = useDashboardContext();

  // Get agent state from both stores (hooks must be called unconditionally)
  // Only extract selectedAgent from sidebar state to minimize subscriptions
  const { selectedAgent: sidebarAgent } = useSidebarAgentState();
  const { selectedAgent: dashboardAgent, activeTab: dashboardActiveTab, setActiveTab: setDashboardActiveTab } = useAgentStore();

  // On dashboard context, use the central agent store; otherwise use sidebar's own store
  const selectedAgent = isDashboardContext ? dashboardAgent : sidebarAgent;

  // Chat tab is only shown when NOT on dashboard context
  const showChatTab = !isDashboardContext;

  // Local tab state for page context (independent from dashboard)
  const [localActiveTab, setLocalActiveTab] = useState<SidebarTab>(showChatTab ? "chat" : "history");

  // Use appropriate tab state based on context
  const activeTab = isDashboardContext ? dashboardActiveTab : localActiveTab;

  const handleTabChange = (tab: string) => {
    const validTab = tab as SidebarTab;
    if (isDashboardContext) {
      setDashboardActiveTab(validTab);
    } else {
      setLocalActiveTab(validTab);
    }
  };

  // Shared trigger styles matching original visual design
  const triggerBaseStyles = cn(
    "relative flex items-center justify-center gap-1 rounded-md px-2 py-2 transition-colors",
    "text-xs font-medium sm:text-sm",
    "data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm",
    "data-[state=inactive]:text-muted-foreground data-[state=inactive]:hover:bg-muted/60 data-[state=inactive]:hover:text-foreground"
  );

  return (
    <aside
      className={cn(
        "flex h-full w-full flex-col text-sidebar-foreground liquid-glass-regular rounded-tl-lg border border-[var(--separator)] shadow-[var(--shadow-elevated)] dark:shadow-none overflow-hidden",
        className,
      )}
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
              showChatTab ? "grid-cols-3" : "grid-cols-2"
            )}
          >
            {showChatTab && (
              <TabsTrigger
                value="chat"
                className={triggerBaseStyles}
              >
                <MessageSquare className="h-4 w-4" />
                <span className="hidden md:inline">Chat</span>
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
              <span className="hidden md:inline">History</span>
              <div
                className={cn(
                  "absolute bottom-0 left-1/2 h-0.5 w-1/2 -translate-x-1/2 bg-primary transition-opacity",
                  activeTab === "history" ? "opacity-100" : "opacity-0"
                )}
              />
            </TabsTrigger>

            <TabsTrigger
              value="settings"
              className={triggerBaseStyles}
            >
              <Settings className="h-4 w-4" />
              <span className="hidden md:inline">Settings</span>
              <div
                className={cn(
                  "absolute bottom-0 left-1/2 h-0.5 w-1/2 -translate-x-1/2 bg-primary transition-opacity",
                  activeTab === "settings" ? "opacity-100" : "opacity-0"
                )}
              />
            </TabsTrigger>
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
              <AssistantChatTab />
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
            <AssistantHistoryTab
              selectedAgent={selectedAgent}
              isDashboardContext={isDashboardContext}
            />
          </TabsContent>
          <TabsContent
            value="settings"
            forceMount
            className={cn(
              "h-full m-0 outline-none",
              activeTab === "settings" ? "flex flex-col" : "hidden"
            )}
          >
            <AssistantSettingsTab
              selectedAgent={selectedAgent}
            />
          </TabsContent>
        </div>
      </Tabs>
    </aside>
  );
}
