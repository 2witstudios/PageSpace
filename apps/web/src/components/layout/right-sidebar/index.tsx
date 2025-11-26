"use client";

import { useEffect, useState } from "react";
import { History, MessageSquare, Settings } from "lucide-react";

import { cn } from "@/lib/utils";
import { useSidebarAgentState } from "@/hooks/useSidebarAgentState";

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
 * This component supports both Global Assistant mode (selectedAgent = null)
 * and Agent mode (selectedAgent is set). The agent selection is managed
 * independently from the middle panel via useSidebarAgentState.
 */
export default function RightPanel({ className }: RightPanelProps) {
  // Get sidebar agent state - independent from middle panel
  const { selectedAgent } = useSidebarAgentState();

  // Always show all 3 tabs - Global Assistant is always available
  const [activeTab, setActiveTab] = useState<string>("chat");

  useEffect(() => {
    const savedTab = localStorage.getItem("globalAssistantActiveTab");
    if (savedTab && ["chat", "history", "settings"].includes(savedTab)) {
      setActiveTab(savedTab);
    }
  }, []);

  useEffect(() => {
    const handleStorageChange = () => {
      const savedTab = localStorage.getItem("globalAssistantActiveTab");
      if (savedTab && ["chat", "history", "settings"].includes(savedTab)) {
        setActiveTab(savedTab);
      }
    };

    window.addEventListener("storage", handleStorageChange);
    return () => window.removeEventListener("storage", handleStorageChange);
  }, []);

  const handleTabChange = (tab: string) => {
    setActiveTab(tab);
    localStorage.setItem("globalAssistantActiveTab", tab);
  };

  return (
    <aside
      className={cn(
        "flex h-full w-full flex-col text-sidebar-foreground liquid-glass-regular rounded-tl-lg border border-[var(--separator)] shadow-[var(--shadow-elevated)] dark:shadow-none overflow-hidden",
        className,
      )}
    >
      <div className="border-b border-[var(--separator)]">
        <div className="grid grid-cols-3 gap-1 px-1 py-1 text-xs font-medium sm:text-sm">
          <button
            onClick={() => handleTabChange("chat")}
            className={cn(
              "relative flex items-center justify-center gap-1 rounded-md px-2 py-2 transition-colors",
              activeTab === "chat"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
            aria-pressed={activeTab === "chat"}
          >
            <MessageSquare className="h-4 w-4" />
            <span className="hidden md:inline">Chat</span>
            {activeTab === "chat" && (
              <div className="absolute bottom-0 left-1/2 h-0.5 w-1/2 -translate-x-1/2 bg-primary" />
            )}
          </button>

          <button
            onClick={() => handleTabChange("history")}
            className={cn(
              "relative flex items-center justify-center gap-1 rounded-md px-2 py-2 transition-colors",
              activeTab === "history"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
            aria-pressed={activeTab === "history"}
          >
            <History className="h-4 w-4" />
            <span className="hidden md:inline">History</span>
            {activeTab === "history" && (
              <div className="absolute bottom-0 left-1/2 h-0.5 w-1/2 -translate-x-1/2 bg-primary" />
            )}
          </button>

          <button
            onClick={() => handleTabChange("settings")}
            className={cn(
              "relative flex items-center justify-center gap-1 rounded-md px-2 py-2 transition-colors",
              activeTab === "settings"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
            aria-pressed={activeTab === "settings"}
          >
            <Settings className="h-4 w-4" />
            <span className="hidden md:inline">Settings</span>
            {activeTab === "settings" && (
              <div className="absolute bottom-0 left-1/2 h-0.5 w-1/2 -translate-x-1/2 bg-primary" />
            )}
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {/* Keep all tabs mounted to preserve state, toggle visibility with CSS */}
        <div style={{ display: activeTab === "chat" ? "flex" : "none", flexDirection: "column", height: "100%" }}>
          <AssistantChatTab />
        </div>
        <div style={{ display: activeTab === "history" ? "flex" : "none", flexDirection: "column", height: "100%" }}>
          <AssistantHistoryTab selectedAgent={selectedAgent} />
        </div>
        <div style={{ display: activeTab === "settings" ? "flex" : "none", flexDirection: "column", height: "100%" }}>
          <AssistantSettingsTab selectedAgent={selectedAgent} />
        </div>
      </div>
    </aside>
  );
}
