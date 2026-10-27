"use client";

import Link from "next/link";
import { toast } from "sonner";
import { HardDrive, Plus, Server } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { workspaces } from "@/lib/mock/workspaces";
import { agents } from "@/lib/mock/agents";
import type { WorkspaceStatus } from "@/lib/mock/types";

const STATUS_TONE: Record<WorkspaceStatus, string> = {
  ready: "text-success",
  booting: "text-warning",
  stopped: "text-muted-foreground",
};

export default function WorkspacesPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Cloud machines your agents run on — each owns its repos and checkouts.
        </p>
        <Button size="sm" className="gap-1.5" onClick={() => toast("Mock: provisioning dialog")}>
          <Plus className="size-4" />
          New workspace
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {workspaces.map((ws) => {
          const running = agents.filter(
            (a) => a.checkout?.workspaceId === ws.id && a.status === "running",
          ).length;
          const diskPct = Math.round((ws.usage.diskUsedGb / ws.usage.diskGb) * 100);
          return (
            <Link
              key={ws.id}
              href={`/workspaces/${ws.id}`}
              className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 shadow-[var(--shadow-ambient)] transition-colors hover:border-primary/40"
            >
              <div className="flex items-center gap-2">
                <Server className="size-4 text-muted-foreground" />
                <span className="font-mono text-sm font-semibold">{ws.name}</span>
                <span className={cn("text-xs capitalize", STATUS_TONE[ws.status])}>● {ws.status}</span>
                <div className="flex-1" />
                <span className="text-xs text-muted-foreground">{ws.region}</span>
              </div>
              <div className="text-xs text-muted-foreground">
                {ws.size} · <span title="The drive whose page tree holds this machine's page">drive: {ws.driveName}</span>
              </div>
              <div className="flex items-center gap-4 text-xs text-muted-foreground">
                <span>
                  {ws.repos.length} {ws.repos.length === 1 ? "repo" : "repos"}
                </span>
                <span>
                  {running} running {running === 1 ? "agent" : "agents"}
                </span>
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <HardDrive className="size-3" />
                    {ws.usage.diskUsedGb} / {ws.usage.diskGb} GB
                  </span>
                  <span>{diskPct}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn("h-full rounded-full", diskPct > 80 ? "bg-warning" : "bg-primary/60")}
                    style={{ width: `${diskPct}%` }}
                  />
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
