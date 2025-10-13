"use client";

import { useAuth } from "@/hooks/use-auth";
import TopBar from "@/components/layout/main-header";
import MemoizedSidebar from "@/components/layout/left-sidebar/MemoizedSidebar";
import CenterPanel from "@/components/layout/middle-content/CenterPanel";
import MemoizedRightPanel from "@/components/layout/right-sidebar/MemoizedRightPanel";
import { NavigationProvider } from "@/components/layout/NavigationProvider";
import { GlobalChatProvider } from "@/contexts/GlobalChatContext";
import { useBreakpoint } from "@/hooks/use-breakpoint";
import { useResponsivePanels } from "@/hooks/use-responsive-panels";
import { motion, AnimatePresence } from "motion/react";
import { DebugPanel } from "./DebugPanel";
import { useLayoutStore } from "@/stores/useLayoutStore";
import { useHasHydrated } from "@/hooks/useHasHydrated";
import { usePerformanceMonitor } from "@/hooks/usePerformanceMonitor";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, memo, useState } from "react";
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
  const { isLoading, isAuthenticated } = useAuth();
  const router = useRouter();
  const isSheetBreakpoint = useBreakpoint("(max-width: 1023px)");
  const {
    leftSidebarOpen,
    rightSidebarOpen,
    toggleLeftSidebar,
    toggleRightSidebar,
    setLeftSidebarOpen,
    setRightSidebarOpen,
  } = useLayoutStore();
  const hasHydrated = useHasHydrated();
  const shouldOverlaySidebars = useBreakpoint("(max-width: 1279px)");
  const [leftSheetOpen, setLeftSheetOpen] = useState(false);
  const [rightSheetOpen, setRightSheetOpen] = useState(false);

  useResponsivePanels();


  // Monitor performance
  usePerformanceMonitor();

  useEffect(() => {
    if (!isSheetBreakpoint) {
      setLeftSheetOpen(false);
      setRightSheetOpen(false);
    }
  }, [isSheetBreakpoint]);

  // Handle authentication redirect with Next.js router for faster navigation
  useEffect(() => {
    if (hasHydrated && !isLoading && !isAuthenticated) {
      console.log('[LAYOUT] Redirecting to signin - hasHydrated:', hasHydrated, 'isLoading:', isLoading, 'isAuthenticated:', isAuthenticated);
      router.push('/auth/signin');
    }
  }, [hasHydrated, isLoading, isAuthenticated, router]);

  const handleLeftPanelToggle = useCallback(() => {
    if (isSheetBreakpoint) {
      setLeftSheetOpen((open) => {
        const nextOpen = !open;
        if (nextOpen && rightSheetOpen) {
          setRightSheetOpen(false);
        }
        return nextOpen;
      });
      return;
    }

    if (shouldOverlaySidebars) {
      if (leftSidebarOpen) {
        setLeftSidebarOpen(false);
      } else {
        if (rightSidebarOpen) {
          setRightSidebarOpen(false);
        }
        setLeftSidebarOpen(true);
      }
      return;
    }

    toggleLeftSidebar();
  }, [
    isSheetBreakpoint,
    rightSheetOpen,
    shouldOverlaySidebars,
    leftSidebarOpen,
    rightSidebarOpen,
    setLeftSidebarOpen,
    setRightSidebarOpen,
    toggleLeftSidebar,
  ]);

  const handleRightPanelToggle = useCallback(() => {
    if (isSheetBreakpoint) {
      setRightSheetOpen((open) => {
        const nextOpen = !open;
        if (nextOpen && leftSheetOpen) {
          setLeftSheetOpen(false);
        }
        return nextOpen;
      });
      return;
    }

    if (shouldOverlaySidebars) {
      if (rightSidebarOpen) {
        setRightSidebarOpen(false);
      } else {
        if (leftSidebarOpen) {
          setLeftSidebarOpen(false);
        }
        setRightSidebarOpen(true);
      }
      return;
    }

    toggleRightSidebar();
  }, [
    isSheetBreakpoint,
    leftSheetOpen,
    shouldOverlaySidebars,
    leftSidebarOpen,
    rightSidebarOpen,
    setLeftSidebarOpen,
    setRightSidebarOpen,
    toggleRightSidebar,
  ]);

  // Optimize loading checks - show UI earlier for better perceived performance
  if (isLoading || !hasHydrated) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-muted-foreground">Loading...</span>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    // Show loading state while redirect happens
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-muted-foreground">Redirecting...</span>
        </div>
      </div>
    );
  }

  return (
    <NavigationProvider>
      <GlobalChatProvider>
        <div className="flex h-[100dvh] min-h-dvh flex-col overflow-hidden bg-gradient-to-br from-background via-background to-muted/10">
          <TopBar
            onToggleLeftPanel={handleLeftPanelToggle}
            onToggleRightPanel={handleRightPanelToggle}
          />

        <div className="relative flex flex-1 min-h-0 overflow-hidden">
          {!shouldOverlaySidebars && leftSidebarOpen && (
            <div className="relative hidden flex-shrink-0 xl:flex xl:w-[18rem] 2xl:w-80 pt-4">
              <MemoizedSidebar className="h-full w-full" />
            </div>
          )}

          <AnimatePresence>
            {shouldOverlaySidebars && !isSheetBreakpoint && leftSidebarOpen && (
              <motion.div
                key="left-sidebar"
                initial={{ x: -320, opacity: 0, scale: 0.98 }}
                animate={{ x: 0, opacity: 1, scale: 1 }}
                exit={{ x: -320, opacity: 0, scale: 0.98 }}
                transition={{
                  type: "spring",
                  stiffness: 300,
                  damping: 30,
                  mass: 0.8
                }}
                className="absolute inset-y-0 left-0 z-40 flex h-full max-w-full"
              >
                <div className="h-full w-[min(22rem,90vw)] max-w-sm">
                  <MemoizedSidebar variant="overlay" className="h-full w-full" />
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {children ? (
              <div className="flex flex-1 flex-col min-h-0 overflow-y-auto">
                {children}
              </div>
            ) : (
              <CenterPanel />
            )}
          </main>

          {!shouldOverlaySidebars && rightSidebarOpen && (
            <div className="relative hidden flex-shrink-0 xl:flex xl:w-[18rem] 2xl:w-80 pt-4">
              <MemoizedRightPanel className="h-full w-full" />
            </div>
          )}

          <AnimatePresence>
            {shouldOverlaySidebars && !isSheetBreakpoint && rightSidebarOpen && (
              <motion.div
                key="right-sidebar"
                initial={{ x: 320, opacity: 0, scale: 0.98 }}
                animate={{ x: 0, opacity: 1, scale: 1 }}
                exit={{ x: 320, opacity: 0, scale: 0.98 }}
                transition={{
                  type: "spring",
                  stiffness: 300,
                  damping: 30,
                  mass: 0.8
                }}
                className="absolute inset-y-0 right-0 z-40 flex h-full max-w-full"
              >
                <div className="h-full w-[min(22rem,90vw)] max-w-sm">
                  <MemoizedRightPanel variant="overlay" className="h-full w-full" />
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <AnimatePresence>
            {shouldOverlaySidebars && !isSheetBreakpoint && (leftSidebarOpen || rightSidebarOpen) && (
              <motion.button
                key="panel-overlay"
                type="button"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="absolute inset-0 z-30 bg-black/50 backdrop-blur-sm"
                aria-label="Close side panels"
                onClick={() => {
                  if (leftSidebarOpen) {
                    setLeftSidebarOpen(false);
                  }
                  if (rightSidebarOpen) {
                    setRightSidebarOpen(false);
                  }
                }}
              />
            )}
          </AnimatePresence>
        </div>

          <DebugPanel />
        </div>

        {isSheetBreakpoint && (
        <>
          <Sheet
            open={leftSheetOpen}
            onOpenChange={(open) => {
              setLeftSheetOpen(open);
              if (open) {
                setRightSheetOpen(false);
              }
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
              if (open) {
                setLeftSheetOpen(false);
              }
            }}
          >
            <SheetContent side="right" className="w-full max-w-[22rem] border-l p-0 sm:max-w-sm">
              <SheetHeader className="sr-only">
                <SheetTitle>Assistant panel</SheetTitle>
                <SheetDescription>Chat with the global assistant</SheetDescription>
              </SheetHeader>
              <MemoizedRightPanel variant="overlay" className="h-full w-full" />
            </SheetContent>
          </Sheet>
        </>
        )}
      </GlobalChatProvider>
    </NavigationProvider>
  );
}

// Memoize Layout to prevent unnecessary re-renders from auth activity updates
export default memo(Layout);