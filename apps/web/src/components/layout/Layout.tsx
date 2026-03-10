"use client";

import { useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
import { cn } from "@/lib/utils";
import { usePanelToggles } from "@/hooks/usePanelToggles";
import { useLayoutInit } from "@/hooks/useLayoutInit";
import { useDeviceTier } from "@/hooks/useDeviceTier";
import { dismissKeyboard } from "@/hooks/useMobileKeyboard";
import TopBar from "@/components/layout/main-header";
import MemoizedSidebar from "@/components/layout/left-sidebar/MemoizedSidebar";
import CenterPanel from "@/components/layout/middle-content/CenterPanel";
import RightPanel from "@/components/layout/right-sidebar";
import { NavigationProvider } from "@/components/layout/NavigationProvider";
import { TabBar } from "@/components/layout/tabs";
import { GlobalChatProvider } from "@/contexts/GlobalChatContext";
import { DebugPanel } from "./DebugPanel";
import { VoiceModeBorder } from "@/components/ai/voice";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

interface LayoutProps {
  children?: React.ReactNode;
}

function Layout({ children }: LayoutProps) {
  const { isLoading, isAuthenticated } = useLayoutInit();
  const { isTablet } = useDeviceTier();
  const {
    toggleLeftPanel,
    toggleRightPanel,
    closeOverlayPanels,
    isSheetBreakpoint,
    shouldOverlayLeftSidebar,
    shouldOverlayRightSidebar,
    leftSidebarOpen,
    rightSidebarOpen,
    leftSheetOpen,
    rightSheetOpen,
    setLeftSheetOpen,
    setRightSheetOpen,
  } = usePanelToggles();

  // Dismiss keyboard when tapping outside editable content
  const handleLayoutClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const isInsideEditable =
      target.closest(".ProseMirror") !== null ||
      target.closest("input") !== null ||
      target.closest("textarea") !== null ||
      target.closest('[contenteditable="true"]') !== null;

    if (!isInsideEditable) dismissKeyboard();
  }, []);

  // Loading state
  if (isLoading) {
    return <LoadingSpinner message="Loading..." />;
  }

  // Auth redirect state
  if (!isAuthenticated) {
    return <LoadingSpinner message="Redirecting..." />;
  }

  return (
    <NavigationProvider>
      <GlobalChatProvider>
        <div
          className="flex flex-col overflow-hidden bg-gradient-to-br from-background via-background to-muted/10"
          style={{ height: "var(--app-height, 100dvh)" }}
          onClick={handleLayoutClick}
        >
          <TopBar
            onToggleLeftPanel={toggleLeftPanel}
            onToggleRightPanel={toggleRightPanel}
          />
          <TabBar />

          <div className="relative flex flex-1 min-h-0 overflow-hidden">
            {/* Persistent Left Sidebar (>=1280px, or iPad >=1024px) */}
            {!shouldOverlayLeftSidebar && !isSheetBreakpoint && leftSidebarOpen && (
              <div
                className={cn(
                  "relative flex-shrink-0 pt-4 overflow-hidden",
                  isTablet ? "flex w-[18rem]" : "hidden xl:flex xl:w-[18rem] 2xl:w-80"
                )}
              >
                <MemoizedSidebar className="h-full w-full" />
              </div>
            )}

            {/* Overlay Left Sidebar (1024-1279px) */}
            <AnimatePresence>
              {shouldOverlayLeftSidebar && !isSheetBreakpoint && leftSidebarOpen && (
                <motion.div
                  key="left-sidebar"
                  initial={{ x: -320, opacity: 0, scale: 0.98 }}
                  animate={{ x: 0, opacity: 1, scale: 1 }}
                  exit={{ x: -320, opacity: 0, scale: 0.98 }}
                  transition={{ type: "spring", stiffness: 300, damping: 30, mass: 0.8 }}
                  className="absolute inset-y-0 left-0 z-40 flex h-full max-w-full"
                >
                  <div className="h-full w-[min(22rem,90vw)] max-w-sm">
                    <MemoizedSidebar variant="overlay" className="h-full w-full" />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Main Content */}
            <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              {children ? (
                <div className="flex flex-1 flex-col min-h-0 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
                  {children}
                </div>
              ) : (
                <CenterPanel />
              )}
              <VoiceModeBorder />
            </main>

            {/* Persistent Right Sidebar (>=1280px, or iPad >=1024px) */}
            {!shouldOverlayRightSidebar && !isSheetBreakpoint && rightSidebarOpen && (
              <div
                className={cn(
                  "relative flex-shrink-0 pt-4 overflow-hidden",
                  isTablet ? "flex w-[18rem]" : "hidden xl:flex xl:w-[18rem] 2xl:w-80"
                )}
              >
                <RightPanel className="h-full w-full" />
              </div>
            )}

            {/* Overlay Right Sidebar (1024-1279px) */}
            <AnimatePresence>
              {shouldOverlayRightSidebar && !isSheetBreakpoint && rightSidebarOpen && (
                <motion.div
                  key="right-sidebar"
                  initial={{ x: 320, opacity: 0, scale: 0.98 }}
                  animate={{ x: 0, opacity: 1, scale: 1 }}
                  exit={{ x: 320, opacity: 0, scale: 0.98 }}
                  transition={{ type: "spring", stiffness: 300, damping: 30, mass: 0.8 }}
                  className="absolute inset-y-0 right-0 z-40 flex h-full max-w-full"
                >
                  <div className="h-full w-[min(22rem,90vw)] max-w-sm">
                    <RightPanel variant="overlay" className="h-full w-full" />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Overlay Backdrop */}
            <AnimatePresence>
              {!isSheetBreakpoint &&
                ((shouldOverlayLeftSidebar && leftSidebarOpen) ||
                  (shouldOverlayRightSidebar && rightSidebarOpen)) && (
                  <motion.button
                    key="panel-overlay"
                    type="button"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="absolute inset-0 z-30 bg-black/50 backdrop-blur-sm"
                    aria-label="Close side panels"
                    onClick={closeOverlayPanels}
                  />
                )}
            </AnimatePresence>
          </div>

          <DebugPanel />
        </div>

        {/* Mobile Sheets */}
        {isSheetBreakpoint && (
          <>
            <Sheet
              open={leftSheetOpen}
              onOpenChange={(open) => {
                setLeftSheetOpen(open);
                if (open) setRightSheetOpen(false);
              }}
            >
              <SheetContent side="left" className="w-full max-w-[22rem] border-r p-0 sm:max-w-sm">
                <SheetHeader className="sr-only">
                  <SheetTitle>Navigation menu</SheetTitle>
                  <SheetDescription>Browse spaces and files</SheetDescription>
                </SheetHeader>
                <MemoizedSidebar variant="overlay" className="h-full w-full" />
              </SheetContent>
            </Sheet>

            <Sheet
              open={rightSheetOpen}
              onOpenChange={(open) => {
                setRightSheetOpen(open);
                if (open) setLeftSheetOpen(false);
              }}
            >
              <SheetContent side="right" className="w-full max-w-[22rem] border-l p-0 sm:max-w-sm">
                <SheetHeader className="sr-only">
                  <SheetTitle>Assistant panel</SheetTitle>
                  <SheetDescription>Chat with the global assistant</SheetDescription>
                </SheetHeader>
                <RightPanel variant="overlay" className="h-full w-full" />
              </SheetContent>
            </Sheet>
          </>
        )}
      </GlobalChatProvider>
    </NavigationProvider>
  );
}

function LoadingSpinner({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center h-screen">
      <div className="flex items-center gap-2">
        <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        <span className="text-sm text-muted-foreground">{message}</span>
      </div>
    </div>
  );
}

export default Layout;
