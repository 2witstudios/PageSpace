"use client";

import { useAuth } from "@/hooks/use-auth";
import TopBar from "@/components/layout/main-header";
import MemoizedSidebar from "@/components/layout/left-sidebar/MemoizedSidebar";
import CenterPanel from "@/components/layout/middle-content/CenterPanel";
import MemoizedRightPanel from "@/components/layout/right-sidebar/MemoizedRightPanel";
import { NavigationProvider } from "@/components/layout/NavigationProvider";
import { useMobile } from "@/hooks/use-mobile";
import { useBreakpoint } from "@/hooks/use-breakpoint";
import { useResponsivePanels } from "@/hooks/use-responsive-panels";
import { motion, AnimatePresence } from "motion/react";
import { DebugPanel } from "./DebugPanel";
import { useLayoutStore } from "@/stores/useLayoutStore";
import { useHasHydrated } from "@/hooks/useHasHydrated";
import { usePerformanceMonitor } from "@/hooks/usePerformanceMonitor";
import { useRouter } from "next/navigation";
import { useEffect, memo } from "react";

interface LayoutProps {
  children?: React.ReactNode;
}

function Layout({ children }: LayoutProps) {
  const { isLoading, isAuthenticated } = useAuth();
  const router = useRouter();
  const isMobile = useMobile();
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

  useResponsivePanels();

  
  // Monitor performance
  usePerformanceMonitor();

  // Handle authentication redirect with Next.js router for faster navigation
  useEffect(() => {
    // Check if we just came from a signup/auth flow
    const urlParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
    const isAuthSuccess = urlParams?.get('auth') === 'success';
    
    if (hasHydrated && !isLoading && !isAuthenticated) {
      // If we have auth=success parameter, give a brief delay for auth check to complete
      if (isAuthSuccess) {
        console.log('[LAYOUT] Auth success detected, delaying signin redirect to allow auth check');
        const timer = setTimeout(() => {
          // Re-check auth state after delay
          if (!isAuthenticated) {
            console.log('[LAYOUT] Auth check delay expired, redirecting to signin');
            router.push('/auth/signin');
          }
        }, 1000); // 1 second delay
        
        return () => clearTimeout(timer);
      } else {
        console.log('[LAYOUT] Redirecting to signin - hasHydrated:', hasHydrated, 'isLoading:', isLoading, 'isAuthenticated:', isAuthenticated);
        router.push('/auth/signin');
      }
    }
  }, [hasHydrated, isLoading, isAuthenticated, router]);

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
      <div className="flex min-h-dvh flex-col overflow-hidden bg-background">
        <TopBar
          onToggleLeftPanel={toggleLeftSidebar}
          onToggleRightPanel={toggleRightSidebar}
        />

        <div className="relative flex flex-1 overflow-hidden">
          {!shouldOverlaySidebars && leftSidebarOpen && (
            <div className="relative hidden h-full flex-shrink-0 border-r bg-sidebar/80 backdrop-blur xl:flex xl:w-[18rem] 2xl:w-80">
              <MemoizedSidebar className="h-full w-full" />
            </div>
          )}

          <AnimatePresence>
            {shouldOverlaySidebars && leftSidebarOpen && (
              <motion.div
                key="left-sidebar"
                initial={{ x: -320, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: -320, opacity: 0 }}
                transition={{ duration: 0.2, ease: "easeInOut" }}
                className="absolute inset-y-0 left-0 z-40 flex h-full max-w-full"
              >
                <div className={isMobile ? "h-full w-screen" : "h-full w-[min(22rem,90vw)] max-w-sm"}>
                  <MemoizedSidebar variant="overlay" className="h-full w-full" />
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
            {children || <CenterPanel />}
          </main>

          {!shouldOverlaySidebars && rightSidebarOpen && (
            <div className="relative hidden h-full flex-shrink-0 border-l bg-sidebar/80 backdrop-blur xl:flex xl:w-[18rem] 2xl:w-80">
              <MemoizedRightPanel className="h-full w-full" />
            </div>
          )}

          <AnimatePresence>
            {shouldOverlaySidebars && rightSidebarOpen && (
              <motion.div
                key="right-sidebar"
                initial={{ x: 320, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: 320, opacity: 0 }}
                transition={{ duration: 0.2, ease: "easeInOut" }}
                className="absolute inset-y-0 right-0 z-40 flex h-full max-w-full"
              >
                <div className={isMobile ? "h-full w-screen" : "h-full w-[min(22rem,90vw)] max-w-sm"}>
                  <MemoizedRightPanel variant="overlay" className="h-full w-full" />
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <AnimatePresence>
            {shouldOverlaySidebars && (leftSidebarOpen || rightSidebarOpen) && (
              <motion.button
                key="panel-overlay"
                type="button"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="absolute inset-0 z-30 bg-black/40"
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
    </NavigationProvider>
  );
}

// Memoize Layout to prevent unnecessary re-renders from auth activity updates
export default memo(Layout);