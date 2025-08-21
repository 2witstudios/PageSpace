"use client";

import { useAuth } from "@/hooks/use-auth";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import TopBar from "@/components/layout/main-header";
import Sidebar from "@/components/layout/left-sidebar";
import CenterPanel from "@/components/layout/middle-content";
import RightPanel from "@/components/layout/right-sidebar";
import { useLayoutStore } from "@/stores/useLayoutStore";
import { useHasHydrated } from "@/hooks/useHasHydrated";
import { useGlobalDriveSocket } from "@/hooks/useGlobalDriveSocket";

export default function Dashboard() {
  const { isLoading, isAuthenticated } = useAuth();
  const router = useRouter();
  const {
    leftSidebarOpen,
    rightSidebarOpen,
    toggleLeftSidebar,
    toggleRightSidebar,
  } = useLayoutStore();
  const hasHydrated = useHasHydrated();
  
  // Initialize global drive socket listener for real-time updates
  useGlobalDriveSocket();

  // Handle authentication redirect in useEffect to avoid updating router during render
  useEffect(() => {
    // Check if we just came from a signup/auth flow
    const urlParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
    const isAuthSuccess = urlParams?.get('auth') === 'success';
    
    if (hasHydrated && !isLoading && !isAuthenticated) {
      // If we have auth=success parameter, give more time for auth check to complete
      if (isAuthSuccess) {
        console.log('[DASHBOARD] Auth success detected, delaying signin redirect to allow auth check');
        const timer = setTimeout(() => {
          // Re-check auth state after delay
          if (!isAuthenticated) {
            console.log('[DASHBOARD] Auth check delay expired, redirecting to signin');
            // Clean up the auth parameter from URL before redirecting
            if (urlParams) {
              urlParams.delete('auth');
              const newUrl = `${window.location.pathname}${urlParams.toString() ? '?' + urlParams.toString() : ''}`;
              window.history.replaceState({}, '', newUrl);
            }
            router.replace("/auth/signin");
          } else {
            // Auth successful, clean up the URL parameter
            console.log('[DASHBOARD] Auth verified, cleaning up URL parameter');
            if (urlParams) {
              urlParams.delete('auth');
              const newUrl = `${window.location.pathname}${urlParams.toString() ? '?' + urlParams.toString() : ''}`;
              window.history.replaceState({}, '', newUrl);
            }
          }
        }, 2000); // Increased to 2 seconds for more reliable auth state hydration
        
        return () => clearTimeout(timer);
      } else {
        console.log('[DASHBOARD] Redirecting to signin - hasHydrated:', hasHydrated, 'isLoading:', isLoading, 'isAuthenticated:', isAuthenticated);
        router.replace("/auth/signin");
      }
    } else if (hasHydrated && !isLoading && isAuthenticated && isAuthSuccess) {
      // User is authenticated and we have auth=success, clean up URL
      console.log('[DASHBOARD] User authenticated with auth=success, cleaning up URL');
      setTimeout(() => {
        if (urlParams) {
          urlParams.delete('auth');
          const newUrl = `${window.location.pathname}${urlParams.toString() ? '?' + urlParams.toString() : ''}`;
          window.history.replaceState({}, '', newUrl);
        }
      }, 500); // Brief delay to ensure state is stable
    }
  }, [hasHydrated, isLoading, isAuthenticated, router]);

  // Show loading state while checking auth or hydrating
  if (isLoading || !hasHydrated) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 dark:border-gray-100"></div>
      </div>
    );
  }

  // Show loading while redirecting
  if (!isAuthenticated) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 dark:border-gray-100"></div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen">
      <TopBar
        onToggleLeftPanel={toggleLeftSidebar}
        onToggleRightPanel={toggleRightSidebar}
      />
      <div className="flex flex-grow overflow-hidden">
        {leftSidebarOpen && <Sidebar />}
        <main className="flex-1 min-w-0 overflow-y-auto">
          <CenterPanel />
        </main>
        {rightSidebarOpen && <RightPanel />}
      </div>
    </div>
  );
}