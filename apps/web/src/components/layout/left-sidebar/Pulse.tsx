"use client";

import { useRef, useEffect, useState } from "react";
import useSWR from "swr";
import { CheckSquare, FileText, Mail, AlertTriangle, TrendingUp, RefreshCw, Sparkles } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { fetchWithAuth } from "@/lib/auth/auth-fetch";
import type { PulseResponse } from "@/app/api/pulse/route";
import { cn } from "@/lib/utils";

const fetcher = async (url: string) => {
  const response = await fetchWithAuth(url);
  if (!response.ok) throw new Error("Failed to fetch");
  return response.json();
};

export default function Pulse() {
  const [isGenerating, setIsGenerating] = useState(false);
  const hasAutoRefreshed = useRef(false);

  const { data, error, isLoading, mutate } = useSWR<PulseResponse>(
    "/api/pulse",
    fetcher,
    {
      refreshInterval: 5 * 60 * 1000, // 5 minutes
      revalidateOnFocus: false,
    }
  );

  // Auto-generate summary if needed (once per session)
  useEffect(() => {
    if (data?.shouldRefresh && !hasAutoRefreshed.current && !isGenerating) {
      hasAutoRefreshed.current = true;
      handleRefresh();
    }
  }, [data?.shouldRefresh, isGenerating]);

  const handleRefresh = async () => {
    if (isGenerating) return;

    setIsGenerating(true);
    try {
      const response = await fetchWithAuth("/api/pulse/generate", {
        method: "POST",
      });

      if (response.ok) {
        // Revalidate the pulse data
        mutate();
      }
    } catch (err) {
      console.error("Failed to generate pulse summary:", err);
    } finally {
      setIsGenerating(false);
    }
  };

  if (isLoading) {
    return <PulseSkeleton />;
  }

  if (error || !data) {
    return null; // Silently fail - not critical
  }

  const { summary, stats } = data;

  const hasActivity =
    stats.tasks.dueToday > 0 ||
    stats.tasks.overdue > 0 ||
    stats.messages.unreadCount > 0 ||
    stats.pages.updatedToday > 0;

  // Don't show if there's nothing to show
  if (!hasActivity && stats.tasks.completedThisWeek === 0 && !summary) {
    return null;
  }

  return (
    <div className="rounded-lg border border-[var(--separator)] bg-card/50 p-3 space-y-3">
      {/* AI Summary Section */}
      {(summary || isGenerating) && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Sparkles className="h-3 w-3 text-primary/70" />
              <h4 className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-medium">
                Pulse
              </h4>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5"
              onClick={handleRefresh}
              disabled={isGenerating}
              title="Refresh summary"
            >
              <RefreshCw className={cn("h-3 w-3", isGenerating && "animate-spin")} />
            </Button>
          </div>

          {isGenerating ? (
            <div className="space-y-1.5">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-4/5" />
              <Skeleton className="h-4 w-3/5" />
            </div>
          ) : summary ? (
            <p className="text-sm text-foreground/90 leading-relaxed">
              {summary.text}
            </p>
          ) : null}

          {summary && !isGenerating && summary.isStale && (
            <p className="text-[10px] text-muted-foreground/50 italic">
              Updated {formatRelativeTime(summary.generatedAt)}
            </p>
          )}
        </div>
      )}

      {/* Quick Stats Section */}
      {(hasActivity || stats.tasks.completedThisWeek > 0) && (
        <>
          {summary && <div className="border-t border-[var(--separator)]" />}

          {/* Today Section */}
          {(stats.tasks.dueToday > 0 || stats.tasks.overdue > 0 || stats.messages.unreadCount > 0 || stats.pages.updatedToday > 0) && (
            <div className="space-y-1.5">
              <h4 className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-medium">
                Today
              </h4>
              <div className="space-y-1">
                {stats.tasks.overdue > 0 && (
                  <PulseItem
                    icon={AlertTriangle}
                    label="overdue"
                    count={stats.tasks.overdue}
                    variant="warning"
                  />
                )}
                {stats.tasks.dueToday > 0 && (
                  <PulseItem
                    icon={CheckSquare}
                    label="tasks due"
                    count={stats.tasks.dueToday}
                  />
                )}
                {stats.messages.unreadCount > 0 && (
                  <PulseItem
                    icon={Mail}
                    label="unread messages"
                    count={stats.messages.unreadCount}
                  />
                )}
                {stats.pages.updatedToday > 0 && (
                  <PulseItem
                    icon={FileText}
                    label="pages updated"
                    count={stats.pages.updatedToday}
                  />
                )}
              </div>
            </div>
          )}

          {/* This Week Section */}
          {(stats.tasks.dueThisWeek > 0 || stats.tasks.completedThisWeek > 0 || stats.pages.updatedThisWeek > 0) && (
            <div className="space-y-1.5">
              <h4 className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-medium">
                This Week
              </h4>
              <div className="space-y-1">
                {stats.tasks.completedThisWeek > 0 && (
                  <PulseItem
                    icon={TrendingUp}
                    label="tasks completed"
                    count={stats.tasks.completedThisWeek}
                    variant="success"
                  />
                )}
                {stats.tasks.dueThisWeek > stats.tasks.dueToday && (
                  <PulseItem
                    icon={CheckSquare}
                    label="tasks due"
                    count={stats.tasks.dueThisWeek}
                  />
                )}
                {stats.pages.updatedThisWeek > stats.pages.updatedToday && (
                  <PulseItem
                    icon={FileText}
                    label="pages updated"
                    count={stats.pages.updatedThisWeek}
                  />
                )}
              </div>
            </div>
          )}
        </>
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
      <div className="space-y-2">
        <div className="flex items-center gap-1.5">
          <Skeleton className="h-3 w-3 rounded-full" />
          <Skeleton className="h-3 w-12" />
        </div>
        <div className="space-y-1.5">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-4/5" />
        </div>
      </div>
      <div className="space-y-1.5">
        <Skeleton className="h-3 w-12" />
        <div className="space-y-1">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-3/4" />
        </div>
      </div>
    </div>
  );
}

function formatRelativeTime(date: Date | string): string {
  const now = new Date();
  const then = new Date(date);
  const diffMs = now.getTime() - then.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return then.toLocaleDateString();
}
