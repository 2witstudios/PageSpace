"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTabsStore } from "@/stores/useTabsStore";

export default function NavButtons() {
  const router = useRouter();

  const canGoBack = useTabsStore((state) => state.selectCanGoBack(state));
  const canGoForward = useTabsStore((state) => state.selectCanGoForward(state));
  const goBackInActiveTab = useTabsStore((state) => state.goBackInActiveTab);
  const goForwardInActiveTab = useTabsStore(
    (state) => state.goForwardInActiveTab
  );

  const handleBack = useCallback(() => {
    goBackInActiveTab();
    const state = useTabsStore.getState();
    const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
    if (activeTab) {
      router.push(activeTab.path);
    }
  }, [goBackInActiveTab, router]);

  const handleForward = useCallback(() => {
    goForwardInActiveTab();
    const state = useTabsStore.getState();
    const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
    if (activeTab) {
      router.push(activeTab.path);
    }
  }, [goForwardInActiveTab, router]);

  return (
    <div className="flex items-center">
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
