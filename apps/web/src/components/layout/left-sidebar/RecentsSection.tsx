"use client";

import { useRouter } from "next/navigation";
import useSWR from "swr";
import { Clock } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { PageTypeIcon } from "@/components/common/PageTypeIcon";
import { useLayoutStore } from "@/stores/useLayoutStore";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { fetchWithAuth } from "@/lib/auth/auth-fetch";
import { cn } from "@/lib/utils";
import type { PageType } from "@pagespace/lib/client-safe";
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

  const { data, isLoading, error } = useSWR<{ recents: RecentPage[] }>(
    "/api/user/recents?limit=8",
    fetcher,
    {
      refreshInterval: 5 * 60 * 1000, // 5 minutes
      revalidateOnFocus: false,
    }
  );

  const handleNavigate = (page: RecentPage) => {
    router.push(`/dashboard/${page.driveId}/${page.id}`);
    if (isSheetBreakpoint) {
      setLeftSheetOpen(false);
    }
  };

  if (isLoading) {
    return <RecentsSkeleton />;
  }

  if (error || !data?.recents || data.recents.length === 0) {
    return null;
  }

  return (
    <div className="space-y-1">
      <h3 className="px-2 text-[10px] uppercase tracking-widest text-muted-foreground/60 font-medium flex items-center gap-1.5">
        <Clock className="h-3 w-3" />
        Recents
      </h3>
      <div className="space-y-0.5">
        {data.recents.map((page) => (
          <RecentItem
            key={page.id}
            page={page}
            onNavigate={() => handleNavigate(page)}
          />
        ))}
      </div>
    </div>
  );
}

interface RecentItemProps {
  page: RecentPage;
  onNavigate: () => void;
}

function RecentItem({ page, onNavigate }: RecentItemProps) {
  return (
    <button
      onClick={onNavigate}
      className={cn(
        "flex items-center gap-2.5 w-full py-1.5 px-2 rounded-md text-sm transition-colors",
        "hover:bg-accent hover:text-accent-foreground",
        "text-left"
      )}
    >
      <PageTypeIcon
        type={page.type as PageType}
        className="h-4 w-4 shrink-0 text-muted-foreground"
      />
      <span className="flex-1 truncate">{page.title}</span>
      <span className="text-[10px] text-muted-foreground/60 shrink-0">
        {formatRelativeTime(page.viewedAt)}
      </span>
    </button>
  );
}

function RecentsSkeleton() {
  return (
    <div className="space-y-1">
      <Skeleton className="h-3 w-14 mx-2" />
      <div className="space-y-0.5">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-3/4" />
        <Skeleton className="h-8 w-5/6" />
      </div>
    </div>
  );
}
