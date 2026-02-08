"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTabsStore } from "@/stores/useTabsStore";
import { canGoBack as canGoBackFn, canGoForward as canGoForwardFn } from "@/lib/tabs/tab-navigation";

export default function NavButtons() {
  const router = useRouter();

  const canGoBack = useTabsStore((state) => state.selectCanGoBack(state));
  const canGoForward = useTabsStore((state) => state.selectCanGoForward(state));
  const goBackInActiveTab = useTabsStore((state) => state.goBackInActiveTab);
  const goForwardInActiveTab = useTabsStore(
    (state) => state.goForwardInActiveTab
  );

  const handleBack = useCallback(() => {
    const { tabs, activeTabId } = useTabsStore.getState();
    const activeTab = tabs.find((t) => t.id === activeTabId);
    if (!activeTab || !canGoBackFn(activeTab)) return;

    const targetPath = activeTab.history[activeTab.historyIndex - 1];
    goBackInActiveTab();
    router.push(targetPath);
  }, [goBackInActiveTab, router]);

  const handleForward = useCallback(() => {
    const { tabs, activeTabId } = useTabsStore.getState();
    const activeTab = tabs.find((t) => t.id === activeTabId);
    if (!activeTab || !canGoForwardFn(activeTab)) return;

    const targetPath = activeTab.history[activeTab.historyIndex + 1];
    goForwardInActiveTab();
    router.push(targetPath);
  }, [goForwardInActiveTab, router]);

  return (
    <div className="hidden sm:flex items-center">
      <Button
        variant="ghost"
        size="icon"
        onClick={handleBack}
        disabled={!canGoBack}
        aria-label="Go back"
        className="h-8 w-8"
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={handleForward}
        disabled={!canGoForward}
        aria-label="Go forward"
        className="h-8 w-8"
      >
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );
}
