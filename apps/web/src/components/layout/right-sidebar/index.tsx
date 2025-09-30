"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { History, MessageSquare, Settings } from "lucide-react";

import { cn } from "@/lib/utils";
import { createClientLogger } from "@/lib/logging/client-logger";

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
  const [activeTab, setActiveTab] = useState<string>(defaultTab);

  useEffect(() => {
    const savedTab = localStorage.getItem("globalAssistantActiveTab");

    if (isDashboardOrDrive && savedTab === "chat") {
      setActiveTab("history");
    } else if (savedTab && ["chat", "history", "settings"].includes(savedTab)) {
      if (!isDashboardOrDrive || savedTab !== "chat") {
        setActiveTab(savedTab);
      }
    }
  }, [isDashboardOrDrive]);

  useEffect(() => {
    const handleStorageChange = () => {
      const savedTab = localStorage.getItem("globalAssistantActiveTab");
      if (savedTab && ["history", "settings"].includes(savedTab)) {
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
        "flex h-full w-full flex-col text-sidebar-foreground liquid-glass-regular rounded-lg border border-[var(--separator)] shadow-[var(--shadow-elevated)]",
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
        {activeTab === "chat" && <AssistantChatTab />}
        {activeTab === "history" && <AssistantHistoryTab />}
        {activeTab === "settings" && <AssistantSettingsTab />}
      </div>
    </aside>
  );
}
