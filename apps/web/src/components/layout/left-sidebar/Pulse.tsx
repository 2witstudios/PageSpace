"use client";

import useSWR from "swr";
import { CheckSquare, FileText, Mail, AlertTriangle, TrendingUp } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchWithAuth } from "@/lib/auth/auth-fetch";
import type { ActivitySummary } from "@/app/api/activity/summary/route";
import { cn } from "@/lib/utils";

const fetcher = async (url: string) => {
  const response = await fetchWithAuth(url);
  if (!response.ok) throw new Error("Failed to fetch");
  return response.json();
};

export default function Pulse() {
  const { data, error, isLoading } = useSWR<ActivitySummary>(
    "/api/activity/summary",
    fetcher,
    {
      refreshInterval: 5 * 60 * 1000, // 5 minutes
      revalidateOnFocus: false,
    }
  );

  if (isLoading) {
    return <PulseSkeleton />;
  }

  if (error || !data) {
    return null; // Silently fail - not critical
  }

  const hasActivity =
    data.tasks.dueToday > 0 ||
    data.tasks.overdue > 0 ||
    data.messages.unreadCount > 0 ||
    data.pages.updatedToday > 0;

  // Don't show if there's nothing to show
  if (!hasActivity && data.tasks.completedThisWeek === 0) {
    return null;
  }

  return (
    <div className="rounded-lg border border-[var(--separator)] bg-card/50 p-3 space-y-3">
      {/* Today Section */}
      {(data.tasks.dueToday > 0 || data.tasks.overdue > 0 || data.messages.unreadCount > 0 || data.pages.updatedToday > 0) && (
        <div className="space-y-1.5">
          <h4 className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-medium">
            Today
          </h4>
          <div className="space-y-1">
            {data.tasks.overdue > 0 && (
              <PulseItem
                icon={AlertTriangle}
                label="overdue"
                count={data.tasks.overdue}
                variant="warning"
              />
            )}
            {data.tasks.dueToday > 0 && (
              <PulseItem
                icon={CheckSquare}
                label="tasks due"
                count={data.tasks.dueToday}
              />
            )}
            {data.messages.unreadCount > 0 && (
              <PulseItem
                icon={Mail}
                label="unread messages"
                count={data.messages.unreadCount}
              />
            )}
            {data.pages.updatedToday > 0 && (
              <PulseItem
                icon={FileText}
                label="pages updated"
                count={data.pages.updatedToday}
              />
            )}
          </div>
        </div>
      )}

      {/* This Week Section */}
      {(data.tasks.dueThisWeek > 0 || data.tasks.completedThisWeek > 0 || data.pages.updatedThisWeek > 0) && (
        <div className="space-y-1.5">
          <h4 className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-medium">
            This Week
          </h4>
          <div className="space-y-1">
            {data.tasks.completedThisWeek > 0 && (
              <PulseItem
                icon={TrendingUp}
                label="tasks completed"
                count={data.tasks.completedThisWeek}
                variant="success"
              />
            )}
            {data.tasks.dueThisWeek > data.tasks.dueToday && (
              <PulseItem
                icon={CheckSquare}
                label="tasks due"
                count={data.tasks.dueThisWeek}
              />
            )}
            {data.pages.updatedThisWeek > data.pages.updatedToday && (
              <PulseItem
                icon={FileText}
                label="pages updated"
                count={data.pages.updatedThisWeek}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface PulseItemProps {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  count: number;
  variant?: "default" | "warning" | "success";
}

function PulseItem({ icon: Icon, label, count, variant = "default" }: PulseItemProps) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <Icon
        className={cn(
          "h-3.5 w-3.5",
          variant === "warning" && "text-orange-500",
          variant === "success" && "text-green-500",
          variant === "default" && "text-muted-foreground"
        )}
      />
      <span
        className={cn(
          "font-semibold tabular-nums",
          variant === "warning" && "text-orange-500",
          variant === "success" && "text-green-500"
        )}
      >
        {count}
      </span>
      <span className="text-muted-foreground">{label}</span>
    </div>
  );
}

function PulseSkeleton() {
  return (
    <div className="rounded-lg border border-[var(--separator)] bg-card/50 p-3 space-y-3">
      <div className="space-y-1.5">
        <Skeleton className="h-3 w-12" />
        <div className="space-y-1">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-3/4" />
        </div>
      </div>
      <div className="space-y-1.5">
        <Skeleton className="h-3 w-16" />
        <div className="space-y-1">
          <Skeleton className="h-5 w-full" />
        </div>
      </div>
    </div>
  );
}
