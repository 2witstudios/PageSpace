"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { composeLine, type ComposedLine } from "@pagespace/lib/home-signals/composer";
import type { HomeContext, Signal } from "@pagespace/lib/home-signals/types";
import { fetchWithAuth } from "@/lib/auth/auth-fetch";
import type { PulseResponse } from "@/app/api/pulse/route";

const fetcher = async (url: string) => {
  const response = await fetchWithAuth(url);
  if (!response.ok) throw new Error("Failed to fetch");
  return response.json();
};

/** JSON round-trips dates as strings — revive the fields composeLine needs. */
function reviveSignals(signals: PulseResponse["signals"]): Signal[] {
  return signals.map((s) => ({
    ...s,
    computedAt: new Date(s.computedAt),
    window: { ...s.window, since: new Date(s.window.since) },
  }));
}

function reviveContext(context: PulseResponse["context"]): HomeContext {
  return {
    ...context,
    lastVisitAt: context.lastVisitAt ? new Date(context.lastVisitAt) : null,
  };
}

const QUIET_LINE: ComposedLine = {
  greeting: "Good morning.",
  lead: null,
  rest: [],
  icon: null,
  suggestions: ["What changed this week?", "Plan today", "Draft a page"],
  leadHref: null,
};

export interface UseHomeSignalsResult {
  /** The composed line, or the quiet-state fallback while loading/erroring. */
  line: ComposedLine;
  isLoading: boolean;
}

/**
 * Fetches `/api/pulse` and composes the Home signal line from it. Moved from
 * the sidebar Pulse widget: this hook also owns the "auto-generate once per
 * session when shouldRefresh" behavior that widget used to own, so removing
 * it from the sidebar doesn't stop Pulse summaries from being generated.
 */
export function useHomeSignals(): UseHomeSignalsResult {
  const [isGenerating, setIsGenerating] = useState(false);
  const hasAutoRefreshed = useRef(false);

  const { data, error, isLoading, mutate } = useSWR<PulseResponse>("/api/pulse", fetcher, {
    refreshInterval: 5 * 60 * 1000,
    revalidateOnFocus: false,
  });

  const handleRefresh = useCallback(async () => {
    if (isGenerating) return;
    setIsGenerating(true);
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const response = await fetchWithAuth("/api/pulse/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone }),
      });
      if (response.ok) mutate();
    } catch (err) {
      console.error("Failed to generate pulse summary:", err);
    } finally {
      setIsGenerating(false);
    }
  }, [isGenerating, mutate]);

  useEffect(() => {
    if (data?.shouldRefresh && !hasAutoRefreshed.current && !isGenerating) {
      hasAutoRefreshed.current = true;
      handleRefresh();
    }
  }, [data?.shouldRefresh, isGenerating, handleRefresh]);

  if (error || !data) {
    return { line: QUIET_LINE, isLoading };
  }

  const line = composeLine(reviveSignals(data.signals), reviveContext(data.context));
  return { line, isLoading };
}
