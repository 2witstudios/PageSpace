"use client";

import { useState } from "react";
import { GitCompare } from "lucide-react";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { agents } from "@/lib/mock/agents";
import { agentDiffs } from "@/lib/mock/diffs";
import AgentStatusDot from "@/components/fleet/AgentStatusDot";
import DiffStatChip from "@/components/fleet/DiffStatChip";
import { DiffFileCard } from "@/components/agent/DiffPanel";

/** Cross-fleet diff (`pu diff`): every agent with changes, one selectable list. */
export default function DiffPage() {
  const changed = agents.filter((a) => a.diff && agentDiffs[a.id]?.branch?.length);
  const [selectedId, setSelectedId] = useState<string | null>(changed[0]?.id ?? null);
  const [statOnly, setStatOnly] = useState(false);

  const selected = changed.find((a) => a.id === selectedId);
  const files = selected ? (agentDiffs[selected.id]?.branch ?? []) : [];

  return (
    <div className="flex h-full min-h-0">
      <div className="w-72 shrink-0 border-r border-[var(--separator)]">
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Agents with changes
          </span>
        </div>
        <div className="space-y-0.5 px-2">
          {changed.map((agent) => (
            <button
              key={agent.id}
              type="button"
              onClick={() => setSelectedId(agent.id)}
              aria-current={selectedId === agent.id ? "true" : undefined}
              className={cn(
                "flex w-full flex-col gap-1 rounded-md px-2 py-1.5 text-left",
                selectedId === agent.id ? "bg-accent" : "hover:bg-accent/50",
              )}
            >
              <span className="flex items-center gap-1.5">
                <AgentStatusDot status={agent.status} />
                <span className="truncate font-mono text-xs">{agent.name}</span>
              </span>
              {agent.diff && <DiffStatChip diff={agent.diff} className="pl-3.5" />}
            </button>
          ))}
        </div>
      </div>

      <div className="min-w-0 flex-1 overflow-y-auto">
        {selected ? (
          <div className="mx-auto max-w-4xl space-y-3 p-4">
            <div className="flex items-center justify-between">
              <div className="font-mono text-xs text-muted-foreground">
                {selected.checkout?.repo} @ {selected.checkout?.branch} — branch vs default
              </div>
              <div className="flex items-center gap-2">
                <Label htmlFor="stat-only" className="text-xs text-muted-foreground">
                  Stat only
                </Label>
                <Switch id="stat-only" checked={statOnly} onCheckedChange={setStatOnly} />
              </div>
            </div>
            {statOnly ? (
              <div className="rounded-lg border border-border bg-card p-3">
                {files.map((file) => (
                  <div key={file.path} className="flex items-center justify-between py-1 font-mono text-xs">
                    <span className="truncate">{file.path}</span>
                    <span className="shrink-0 pl-4">
                      <span className="text-success">+{file.additions}</span>{" "}
                      <span className="text-destructive">−{file.deletions}</span>
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="space-y-2">
                {files.map((file) => (
                  <DiffFileCard key={file.path} file={file} />
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <GitCompare className="size-10 text-muted-foreground" />
            <h2 className="text-lg font-semibold">Nothing to diff</h2>
            <p className="text-sm text-muted-foreground">No agent has changes right now.</p>
          </div>
        )}
      </div>
    </div>
  );
}
