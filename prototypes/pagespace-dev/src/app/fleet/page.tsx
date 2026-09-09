"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { agents, statusRank } from "@/lib/mock/agents";
import type { AgentStatus } from "@/lib/mock/types";
import AgentCard from "@/components/fleet/AgentCard";

const FILTERS = ["all", "running", "waiting", "broken", "benched"] as const;
type Filter = (typeof FILTERS)[number];

const STAT_TONES: Record<AgentStatus, string> = {
  running: "text-success",
  waiting: "text-warning",
  broken: "text-destructive",
  benched: "text-muted-foreground",
};

/** Fleet — the pulse. Waiting agents float to the top; they're the ones asking for you. */
export default function FleetPage() {
  const [filter, setFilter] = useState<Filter>("all");

  const counts = (["running", "waiting", "broken", "benched"] as const).map((status) => ({
    status,
    count: agents.filter((a) => a.status === status).length,
  }));

  const visible = agents
    .filter((a) => filter === "all" || a.status === filter)
    .sort((a, b) => Number(b.isPointGuard ?? false) - Number(a.isPointGuard ?? false) || statusRank[a.status] - statusRank[b.status]);

  const pointGuard = visible.find((a) => a.isPointGuard);
  const rest = visible.filter((a) => !a.isPointGuard);

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {counts.map(({ status, count }) => (
          <button
            key={status}
            type="button"
            onClick={() => setFilter(filter === status ? "all" : status)}
            className={cn(
              "rounded-lg border border-border bg-card p-4 text-left shadow-[var(--shadow-ambient)] transition-colors",
              filter === status ? "border-primary/50" : "hover:border-primary/30",
            )}
          >
            <div className={cn("text-2xl font-semibold tabular-nums", count > 0 ? STAT_TONES[status] : "text-muted-foreground/50")}>
              {count}
            </div>
            <div className="mt-1 text-xs capitalize text-muted-foreground">
              {status === "waiting" ? "waiting on input" : status}
            </div>
          </button>
        ))}
      </div>

      <div className="flex items-center gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs capitalize transition-colors",
              filter === f
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground",
            )}
          >
            {f}
          </button>
        ))}
      </div>

      {pointGuard && <AgentCard agent={pointGuard} />}

      {rest.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          {rest.map((agent) => (
            <AgentCard key={agent.id} agent={agent} />
          ))}
        </div>
      ) : (
        !pointGuard && (
          <div className="flex flex-col items-center gap-2 py-24 text-center">
            <div className="text-lg font-semibold">No agents in flight</div>
            <p className="text-sm text-muted-foreground">
              Spawn your first — ⌘K from anywhere.
            </p>
          </div>
        )
      )}
    </div>
  );
}
