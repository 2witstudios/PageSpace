"use client";

import { useAuth } from "@/hooks/useAuth";
import { useSocket } from "@/hooks/useSocket";
import { useAccessRevocation } from "@/hooks/useAccessRevocation";
import TopBar from "@/components/layout/main-header";
import MemoizedSidebar from "@/components/layout/left-sidebar/MemoizedSidebar";
import CenterPanel from "@/components/layout/middle-content/CenterPanel";
import RightPanel from "@/components/layout/right-sidebar";
import { NavigationProvider } from "@/components/layout/NavigationProvider";
import { TabBar } from "@/components/layout/tabs";
import { GlobalChatProvider } from "@/contexts/GlobalChatContext";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { useResponsivePanels } from "@/hooks/useResponsivePanels";
import { motion, AnimatePresence } from "motion/react";
import { DebugPanel } from "./DebugPanel";
import { useLayoutStore } from "@/stores/useLayoutStore";
import { useHasHydrated } from "@/hooks/useHasHydrated";
import { usePerformanceMonitor } from "@/hooks/usePerformanceMonitor";
import { useIOSKeyboardInit } from "@/hooks/useIOSKeyboardInit";
import { dismissKeyboard } from "@/hooks/useMobileKeyboard";
import { useTabSync } from "@/hooks/useTabSync";
import { useRouter } from "next/navigation";
import { useCallback, useEffect } from "react";
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

  // Use selective Zustand subscriptions to prevent re-renders when unrelated store values change
  // This ensures Layout only re-renders when these specific sidebar values actually change
  const leftSidebarOpen = useLayoutStore(state => state.leftSidebarOpen);
  const rightSidebarOpen = useLayoutStore(state => state.rightSidebarOpen);
  const toggleLeftSidebar = useLayoutStore(state => state.toggleLeftSidebar);
  const toggleRightSidebar = useLayoutStore(state => state.toggleRightSidebar);
  const setLeftSidebarOpen = useLayoutStore(state => state.setLeftSidebarOpen);
  const setRightSidebarOpen = useLayoutStore(state => state.setRightSidebarOpen);

  // Mobile sheet state from store (allows other components to control sheets)
  const leftSheetOpen = useLayoutStore(state => state.leftSheetOpen);
  const rightSheetOpen = useLayoutStore(state => state.rightSheetOpen);
  const setLeftSheetOpen = useLayoutStore(state => state.setLeftSheetOpen);
  const setRightSheetOpen = useLayoutStore(state => state.setRightSheetOpen);

  const hasHydrated = useHasHydrated();
  const shouldOverlaySidebars = useBreakpoint("(max-width: 1279px)");

  useResponsivePanels();

  // Initialize socket connection for real-time features
  useSocket();

  // Handle real-time permission revocation (zero-trust security)
  useAccessRevocation();

  // Monitor performance
  usePerformanceMonitor();

  // Initialize iOS keyboard listeners (sets --keyboard-height CSS var)
  useIOSKeyboardInit();

  // Keep tab store in sync for both CenterPanel routes and full-page dashboard routes.
  useTabSync();

  useEffect(() => {
    if (!isSheetBreakpoint) {
      setLeftSheetOpen(false);
      setRightSheetOpen(false);
    }
  }, [isSheetBreakpoint, setLeftSheetOpen, setRightSheetOpen]);


  // Handle authentication redirect with Next.js router for faster navigation
  useEffect(() => {
    if (hasHydrated && !isLoading && !isAuthenticated) {
      console.log('[LAYOUT] Redirecting to signin - hasHydrated:', hasHydrated, 'isLoading:', isLoading, 'isAuthenticated:', isAuthenticated);
      router.push('/auth/signin');
    }
  }, [hasHydrated, isLoading, isAuthenticated, router]);

  const handleLeftPanelToggle = useCallback(() => {
    dismissKeyboard();
    if (isSheetBreakpoint) {
      const nextOpen = !leftSheetOpen;
      if (nextOpen && rightSheetOpen) {
        setRightSheetOpen(false);
      }
      setLeftSheetOpen(nextOpen);
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
    leftSheetOpen,
    rightSheetOpen,
    shouldOverlaySidebars,
    leftSidebarOpen,
    rightSidebarOpen,
    setLeftSheetOpen,
    setRightSheetOpen,
    setLeftSidebarOpen,
    setRightSidebarOpen,
    toggleLeftSidebar,
  ]);

  const handleRightPanelToggle = useCallback(() => {
    dismissKeyboard();
    if (isSheetBreakpoint) {
      const nextOpen = !rightSheetOpen;
      if (nextOpen && leftSheetOpen) {
        setLeftSheetOpen(false);
      }
      setRightSheetOpen(nextOpen);
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
    rightSheetOpen,
    shouldOverlaySidebars,
    leftSidebarOpen,
    rightSidebarOpen,
    setLeftSheetOpen,
    setRightSheetOpen,
    setLeftSidebarOpen,
    setRightSidebarOpen,
    toggleRightSidebar,
  ]);

  // Dismiss keyboard when tapping outside editable content (iOS Capacitor fix)
  // iOS contenteditable elements don't automatically blur on outside taps like regular inputs
  const handleLayoutClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;

    // Don't dismiss if clicking inside editable content
    const isInsideEditable =
      target.closest('.ProseMirror') !== null ||           // TipTap editor
      target.closest('input') !== null ||                  // Input fields
      target.closest('textarea') !== null ||               // Textareas
      target.closest('[contenteditable="true"]') !== null; // Other contenteditable

    if (!isInsideEditable) {
      dismissKeyboard();
    }
  }, []);

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
        <div
          className="flex flex-col overflow-hidden bg-gradient-to-br from-background via-background to-muted/10"
          style={{ height: 'var(--app-height, 100dvh)' }}
          onClick={handleLayoutClick}
        >
          <TopBar
            onToggleLeftPanel={handleLeftPanelToggle}
            onToggleRightPanel={handleRightPanelToggle}
          />

          {/* TabBar: auto-hides when <=1 tab, accordion from TopBar */}
          <TabBar />

        <div className="relative flex flex-1 min-h-0 overflow-hidden">
          {!shouldOverlaySidebars && leftSidebarOpen && (
            <div className="relative hidden flex-shrink-0 xl:flex xl:w-[18rem] 2xl:w-80 pt-4 overflow-hidden">
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
              <div className="flex flex-1 flex-col min-h-0 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
                {children}
              </div>
            ) : (
              <CenterPanel />
            )}
          </main>

          {!shouldOverlaySidebars && rightSidebarOpen && (
            <div className="relative hidden flex-shrink-0 xl:flex xl:w-[18rem] 2xl:w-80 pt-4 overflow-hidden">
              <RightPanel className="h-full w-full" />
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
                  <RightPanel variant="overlay" className="h-full w-full" />
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
              <RightPanel variant="overlay" className="h-full w-full" />
            </SheetContent>
          </Sheet>
        </>
        )}
      </GlobalChatProvider>
    </NavigationProvider>
  );
}

// Export Layout without memo to allow real-time updates from GlobalChatContext
// The selective Zustand subscriptions (lines 38-43) already prevent unnecessary re-renders
export default Layout;
