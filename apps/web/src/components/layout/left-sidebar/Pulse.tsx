"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import useSWR from "swr";
import { ChevronDown, RefreshCw } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { fetchWithAuth } from "@/lib/auth/auth-fetch";
import type { PulseResponse } from "@/app/api/pulse/route";
import { useLayoutStore } from "@/stores/useLayoutStore";
import { cn } from "@/lib/utils";

const fetcher = async (url: string) => {
  const response = await fetchWithAuth(url);
  if (!response.ok) throw new Error("Failed to fetch");
  return response.json();
};

export default function Pulse() {
  const [isGenerating, setIsGenerating] = useState(false);
  const hasAutoRefreshed = useRef(false);
  const pulseCollapsed = useLayoutStore((state) => state.pulseCollapsed);
  const setPulseCollapsed = useLayoutStore((state) => state.setPulseCollapsed);

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
      // Send browser timezone for accurate time-of-day context
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const response = await fetchWithAuth("/api/pulse/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ timezone }),
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
    <Collapsible
      open={!pulseCollapsed}
      onOpenChange={(open) => setPulseCollapsed(!open)}
      className="border-t border-[var(--separator)]"
    >
      <div className="flex items-center">
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            className="flex-1 justify-between px-2 py-2 h-auto font-normal text-muted-foreground hover:text-foreground"
          >
            <span className="text-xs font-medium">Pulse</span>
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 transition-transform duration-200",
                !pulseCollapsed && "rotate-180"
              )}
            />
          </Button>
        </CollapsibleTrigger>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0 mr-1 text-muted-foreground hover:text-foreground"
          onClick={handleRefresh}
          disabled={isGenerating}
          title="Refresh summary"
          aria-label="Refresh summary"
        >
          <RefreshCw className={cn("h-3 w-3", isGenerating && "animate-spin")} />
        </Button>
      </div>
      <CollapsibleContent className="px-2 pb-2">
        <div className="space-y-2">
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
      </CollapsibleContent>
    </Collapsible>
  );
}

function PulseSkeleton() {
  return (
    <div className="border-t border-[var(--separator)]">
      <div className="flex items-center justify-between px-2 py-2">
        <Skeleton className="h-4 w-12" />
        <Skeleton className="h-3.5 w-3.5" />
      </div>
      <div className="px-2 pb-2 space-y-1.5">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-4 w-3/5" />
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
