"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import useSWR from "swr";
import { RefreshCw } from "lucide-react";
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

  const handleRefresh = useCallback(async () => {
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
  }, [isGenerating, mutate]);

  // Auto-generate summary if needed (once per session)
  useEffect(() => {
    if (data?.shouldRefresh && !hasAutoRefreshed.current && !isGenerating) {
      hasAutoRefreshed.current = true;
      handleRefresh();
    }
  }, [data?.shouldRefresh, isGenerating, handleRefresh]);

  if (isLoading) {
    return <PulseSkeleton />;
  }

  if (error || !data) {
    return null; // Silently fail - not critical
  }

  const { summary } = data;

  // Don't show if there's no summary
  if (!summary && !isGenerating) {
    return null;
  }

  return (
    <div className="rounded-lg border border-[var(--separator)] bg-card/50 p-3">
      {/* AI Summary Section */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-medium">
            Pulse
          </h4>
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
    </div>
  );
}

function PulseSkeleton() {
  return (
    <div className="rounded-lg border border-[var(--separator)] bg-card/50 p-3">
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Skeleton className="h-3 w-12" />
          <Skeleton className="h-5 w-5 rounded" />
        </div>
        <div className="space-y-1.5">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-4 w-3/5" />
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
