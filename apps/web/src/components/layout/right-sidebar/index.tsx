"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { History, MessageSquare, Settings } from "lucide-react";

import { cn } from "@/lib/utils";
import { createClientLogger } from "@/lib/logging/client-logger";
import { useLocalStorage } from "@/hooks/useLocalStorage";

import AssistantChatTab from "./ai-assistant/AssistantChatTab";
import AssistantHistoryTab from "./ai-assistant/AssistantHistoryTab";
import AssistantSettingsTab from "./ai-assistant/AssistantSettingsTab";

export interface RightPanelProps {
  className?: string;
  variant?: "desktop" | "overlay";
}

const panelLogger = createClientLogger({ namespace: "ui", component: "right-sidebar" });

export default function RightPanel({ className }: RightPanelProps) {
  const pathname = usePathname();
  panelLogger.debug("Evaluating RightPanel pathname", {
    pathname,
    pathnameType: typeof pathname,
  });

  let isDashboardOrDrive = false;

  if (pathname && typeof pathname === "string") {
    try {
      const matchResult = pathname.match(/^\/dashboard\/[^/]+$/);
      panelLogger.debug("RightPanel pathname match evaluated", {
        matchFound: Boolean(matchResult),
      });
      isDashboardOrDrive = pathname === "/dashboard" || Boolean(matchResult);
    } catch (error) {
      panelLogger.error("Failed to evaluate pathname match in RightPanel", {
        error: error instanceof Error ? error : String(error),
      });
      isDashboardOrDrive = false;
    }
  } else {
    panelLogger.warn("RightPanel received null or undefined pathname");
    isDashboardOrDrive = false;
  }

  panelLogger.debug("RightPanel computed dashboard/drive state", {
    isDashboardOrDrive,
  });

  const defaultTab = isDashboardOrDrive ? "history" : "chat";
  const [activeTab, setActiveTab] = useLocalStorage("globalAssistantActiveTab", defaultTab);

  // Override chat tab to history when on dashboard/drive view
  useEffect(() => {
    if (isDashboardOrDrive && activeTab === "chat") {
      setActiveTab("history");
    }
  }, [isDashboardOrDrive, activeTab, setActiveTab]);

  const handleTabChange = (tab: string) => {
    setActiveTab(tab);
  };

  return (
    <aside
      className={cn(
        "flex h-full w-full flex-col text-sidebar-foreground liquid-glass-regular rounded-tl-lg border border-[var(--separator)] shadow-[var(--shadow-elevated)] dark:shadow-none overflow-hidden",
        className,
      )}
    >
      <div className="border-b border-[var(--separator)]">
        <div
          className={cn(
            "grid gap-1 px-1 py-1 text-xs font-medium sm:text-sm",
            isDashboardOrDrive ? "grid-cols-2" : "grid-cols-3",
          )}
        >
          {!isDashboardOrDrive && (
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
          )}

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
          <AssistantHistoryTab />
        </div>
        <div style={{ display: activeTab === "settings" ? "flex" : "none", flexDirection: "column", height: "100%" }}>
          <AssistantSettingsTab />
        </div>
      </div>
    </aside>
  );
}
