"use client";

import { useCallback, type MouseEvent } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { ChevronDown, Clock, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { PageTypeIcon } from "@/components/common/PageTypeIcon";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useLayoutStore } from "@/stores/useLayoutStore";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { useCapacitor } from "@/hooks/useCapacitor";
import { useTabsStore } from "@/stores/useTabsStore";
import { shouldOpenInNewTab } from "@/lib/tabs/tab-navigation-utils";
import { fetchWithAuth } from "@/lib/auth/auth-fetch";
import { cn } from "@/lib/utils";
import type { RecentPage } from "@/app/api/user/recents/route";

const fetcher = async (url: string) => {
  const response = await fetchWithAuth(url);
  if (!response.ok) throw new Error("Failed to fetch");
  return response.json();
};

function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function RecentsSection() {
  const router = useRouter();
  const isSheetBreakpoint = useBreakpoint("(max-width: 1023px)");
  const setLeftSheetOpen = useLayoutStore((state) => state.setLeftSheetOpen);
  const recentsCollapsed = useLayoutStore((state) => state.recentsCollapsed);
  const setRecentsCollapsed = useLayoutStore((state) => state.setRecentsCollapsed);
  const createTab = useTabsStore((state) => state.createTab);
  const { isNative } = useCapacitor();

  const { data, isLoading, error } = useSWR<{ recents: RecentPage[] }>(
    "/api/user/recents?limit=8",
    fetcher,
    {
      refreshInterval: 5 * 60 * 1000, // 5 minutes
      revalidateOnFocus: false,
    }
  );

  const handleNavigate = useCallback((page: RecentPage, e?: MouseEvent) => {
    const href = `/dashboard/${page.driveId}/${page.id}`;

    if (e && shouldOpenInNewTab(e)) {
      e.preventDefault();
      createTab({ path: href });
      return;
    }

    router.push(href);
    if (isSheetBreakpoint) {
      setLeftSheetOpen(false);
    }
  }, [router, isSheetBreakpoint, setLeftSheetOpen, createTab]);

  const handleOpenInNewTab = useCallback((page: RecentPage) => {
    createTab({ path: `/dashboard/${page.driveId}/${page.id}` });
  }, [createTab]);

  if (isLoading) {
    return <RecentsSkeleton />;
  }

  if (error) {
    return null;
  }

  const recents = data?.recents ?? [];

  return (
    <Collapsible
      open={!recentsCollapsed}
      onOpenChange={(open) => setRecentsCollapsed(!open)}
      className="border-t border-[var(--sidebar-divider)]"
    >
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          className="w-full justify-between px-2 py-2.5 h-auto font-normal text-muted-foreground hover:text-foreground bg-[var(--sidebar-section-bg)]"
        >
          <span className="text-[11px] font-semibold tracking-wide flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5" />
            Recents
          </span>
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 transition-transform duration-200",
              !recentsCollapsed && "rotate-180"
            )}
          />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="pb-1">
        {recents.length === 0 ? (
          <p className="px-2 py-1 text-xs text-muted-foreground/50">No recent pages</p>
        ) : (
          <div className="space-y-0.5">
            {recents.map((page) => (
              <RecentItem
                key={page.id}
                page={page}
                onNavigate={(e) => handleNavigate(page, e)}
                onOpenInNewTab={() => handleOpenInNewTab(page)}
                isNative={isNative}
              />
            ))}
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

interface RecentItemProps {
  page: RecentPage;
  onNavigate: (e: MouseEvent<HTMLButtonElement>) => void;
  onOpenInNewTab: () => void;
  isNative: boolean;
}

function RecentItem({ page, onNavigate, onOpenInNewTab, isNative }: RecentItemProps) {
  const content = (
    <button
      onClick={onNavigate}
      onAuxClick={isNative ? undefined : (e) => {
        if (e.button === 1) {
          e.preventDefault();
          onOpenInNewTab();
        }
      }}
      className={cn(
        "flex items-center gap-2.5 w-full py-1.5 px-2 rounded-md text-sm transition-colors",
        "hover:bg-accent hover:text-accent-foreground",
        "text-left"
      )}
    >
      <PageTypeIcon
        type={page.type}
        className="h-4 w-4 shrink-0 text-muted-foreground"
      />
      <span className="flex-1 truncate">{page.title}</span>
      <span className="text-[10px] text-muted-foreground/60 shrink-0">
        {formatRelativeTime(page.viewedAt)}
      </span>
    </button>
  );

  // On native apps, don't show the context menu with "Open in new tab"
  if (isNative) {
    return content;
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {content}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onOpenInNewTab}>
          <ExternalLink className="mr-2 h-4 w-4" />
          Open in new tab
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function RecentsSkeleton() {
  return (
    <div className="border-t border-[var(--sidebar-divider)]">
      <div className="flex items-center justify-between px-2 py-2.5 bg-[var(--sidebar-section-bg)]">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-3.5 w-3.5" />
      </div>
      <div className="space-y-0.5 pb-1">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-3/4" />
        <Skeleton className="h-8 w-5/6" />
      </div>
    </div>
  );
}
