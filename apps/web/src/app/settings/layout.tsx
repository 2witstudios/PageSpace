"use client";

import { useAuth } from "@/hooks/use-auth";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import TopBar from "@/components/layout/main-header";
import Sidebar from "@/components/layout/left-sidebar";
import RightPanel from "@/components/layout/right-sidebar";
import { useLayoutStore } from "@/stores/useLayoutStore";
import { useHasHydrated } from "@/hooks/useHasHydrated";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const { isLoading, isAuthenticated } = useAuth();
  const router = useRouter();
  const {
    leftSidebarOpen,
    rightSidebarOpen,
    toggleLeftSidebar,
    toggleRightSidebar,
  } = useLayoutStore();
  const hasHydrated = useHasHydrated();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.push('/auth/signin');
    }
  }, [isLoading, isAuthenticated, router]);

  if (isLoading || !hasHydrated) {
    return <p>Loading...</p>;
  }

  if (!isAuthenticated) {
    router.push("/auth/signin");
    return null;
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
          {children}
        </main>
        {rightSidebarOpen && <RightPanel />}
      </div>
    </div>
  );
}