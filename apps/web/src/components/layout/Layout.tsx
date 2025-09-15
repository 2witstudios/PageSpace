"use client";

import { useAuth } from "@/hooks/use-auth";
import TopBar from "@/components/layout/main-header";
import MemoizedSidebar from "@/components/layout/left-sidebar/MemoizedSidebar";
import CenterPanel from "@/components/layout/middle-content/CenterPanel";
import MemoizedRightPanel from "@/components/layout/right-sidebar/MemoizedRightPanel";
import { NavigationProvider } from "@/components/layout/NavigationProvider";
import { useMobile } from "@/hooks/use-mobile";
import { motion, AnimatePresence } from "motion/react";
import { DebugPanel } from "./DebugPanel";
import { useLayoutStore } from "@/stores/useLayoutStore";
import { useHasHydrated } from "@/hooks/useHasHydrated";
import { usePerformanceMonitor } from "@/hooks/usePerformanceMonitor";
import { useRouter, usePathname } from "next/navigation";
import { useEffect, memo } from "react";

interface LayoutProps {
  children?: React.ReactNode;
}

function Layout({ children }: LayoutProps) {
  const { isLoading, isAuthenticated } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const isMobile = useMobile();
  const {
    leftSidebarOpen,
    rightSidebarOpen,
    toggleLeftSidebar,
    toggleRightSidebar,
  } = useLayoutStore();
  const hasHydrated = useHasHydrated();

  // Check if we're on the messages route
  const isMessagesRoute = pathname?.startsWith('/dashboard/messages');
  
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
      <div className="flex flex-col h-screen overflow-hidden">
        <TopBar
          onToggleLeftPanel={toggleLeftSidebar}
          onToggleRightPanel={toggleRightSidebar}
        />
        
        <div className="flex flex-grow overflow-hidden relative">
          {/* Desktop Left Sidebar - Don't show on messages routes */}
          {leftSidebarOpen && !isMobile && !isMessagesRoute && (
            <div className="flex-shrink-0 w-80 overflow-hidden transition-all duration-200 ease-in-out">
              <MemoizedSidebar />
            </div>
          )}

          {/* Mobile Left Sidebar - Don't show on messages routes */}
          <AnimatePresence>
            {isMobile && leftSidebarOpen && !isMessagesRoute && (
              <>
                <motion.div
                  initial={{ x: -320, opacity: 0 }}
                  animate={{ x: 0, opacity: 1 }}
                  exit={{ x: -320, opacity: 0 }}
                  transition={{ duration: 0.2, ease: "easeInOut" }}
                  className="absolute top-0 left-0 h-full z-40"
                >
                  <MemoizedSidebar />
                </motion.div>
                
                {/* Mobile Overlay */}
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="absolute inset-0 bg-black/30 z-30"
                  onClick={toggleLeftSidebar}
                />
              </>
            )}
          </AnimatePresence>

          {/* Main Content Area */}
          <main className="flex-1 min-w-0 overflow-hidden bg-background relative">
            {/* Use our center panel instead of children */}
            {children || <CenterPanel />}
          </main>

          {/* Desktop Right Sidebar */}
          {rightSidebarOpen && !isMobile && (
            <div className="flex-shrink-0 w-80 overflow-hidden transition-all duration-200 ease-in-out">
              <MemoizedRightPanel />
            </div>
          )}

          {/* Mobile Right Sidebar */}
          <AnimatePresence>
            {isMobile && rightSidebarOpen && (
              <>
                <motion.div
                  initial={{ x: 320, opacity: 0 }}
                  animate={{ x: 0, opacity: 1 }}
                  exit={{ x: 320, opacity: 0 }}
                  transition={{ duration: 0.2, ease: "easeInOut" }}
                  className="absolute top-0 right-0 h-full z-40"
                >
                  <MemoizedRightPanel />
                </motion.div>
                
                {/* Mobile Overlay (if not already shown for left sidebar) */}
                {!leftSidebarOpen && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="absolute inset-0 bg-black/30 z-30"
                    onClick={toggleRightSidebar}
                  />
                )}
              </>
            )}
          </AnimatePresence>
        </div>
        
        {/* Debug Panel for Development */}
        <DebugPanel />
      </div>
    </NavigationProvider>
  );
}

// Memoize Layout to prevent unnecessary re-renders from auth activity updates
export default memo(Layout);