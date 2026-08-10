"use client";

import Link from "next/link";
import { toast } from "sonner";
import { FolderGit2, GitBranch, Plus, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { workspaceById } from "@/lib/mock/workspaces";
import { agentById } from "@/lib/mock/agents";
import AgentStatusDot, { STATUS_LABEL } from "./AgentStatusDot";
import RuntimeBadge from "./RuntimeBadge";
import DiffStatChip from "./DiffStatChip";

export default function WorkspaceDetail({ wsId }: { wsId: string }) {
  const ws = workspaceById(wsId);
  if (!ws) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <Server className="size-10 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Workspace not found</h2>
      </div>
    );
  }

  const wsAgents = ws.repos.flatMap((repo) =>
    repo.branches.flatMap((b) => b.agentIds.map((id) => agentById(id)).filter((a) => a !== undefined)),
  );

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Server className="size-5 text-muted-foreground" />
        <div>
          <div className="font-mono text-base font-semibold">{ws.name}</div>
          <div className="text-xs text-muted-foreground">
            {ws.size} · {ws.region} · {ws.status} ·{" "}
            <span title="The drive whose page tree holds this machine's page">drive: {ws.driveName}</span>
          </div>
        </div>
        <div className="flex-1" />
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => toast("Mock: add repo dialog")}>
          <Plus className="size-4" />
          Add repo
        </Button>
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Checkouts</h2>
        <div className="rounded-lg border border-border bg-card">
          {ws.repos.map((repo) => (
            <div key={repo.name} className="border-b border-[var(--separator)] p-3 last:border-b-0">
              <div className="group flex items-center gap-2">
                <FolderGit2 className="size-4 text-muted-foreground" />
                <span className="font-mono text-sm">{repo.name}</span>
                <span className="text-[11px] text-muted-foreground">default {repo.defaultBranch}</span>
                <div className="flex-1" />
                <button
                  type="button"
                  className="rounded-sm p-1 opacity-0 hover:bg-accent group-hover:opacity-100"
                  aria-label={`Add branch to ${repo.name}`}
                  onClick={() => toast(`Mock: add branch to ${repo.name}`)}
                >
                  <Plus className="size-3.5" />
                </button>
              </div>
              <div className="mt-1.5 space-y-1 pl-6">
                {repo.branches.length === 0 && (
                  <div className="text-xs text-muted-foreground">No checkouts yet</div>
                )}
                {repo.branches.map((branch) => (
                  <div key={branch.name} className="flex items-center gap-2 text-xs">
                    <GitBranch className="size-3 text-muted-foreground" />
                    <span className="font-mono">{branch.name}</span>
                    <span className="text-muted-foreground">
                      {branch.agentIds.length} {branch.agentIds.length === 1 ? "agent" : "agents"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Agents on this workspace</h2>
        {wsAgents.length === 0 ? (
          <p className="text-sm text-muted-foreground">None — spawn one with ⌘K.</p>
        ) : (
          <div className="rounded-lg border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Agent</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Branch</TableHead>
                  <TableHead className="text-right">Changes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {wsAgents.map((agent) => (
                  <TableRow key={agent.id}>
                    <TableCell>
                      <Link href={`/agents/${agent.id}`} className="flex items-center gap-2 hover:underline">
                        <span className="font-mono text-xs">{agent.name}</span>
                        <RuntimeBadge runtime={agent.runtime} />
                      </Link>
                    </TableCell>
                    <TableCell>
                      <span className="flex items-center gap-1.5 text-xs">
                        <AgentStatusDot status={agent.status} />
                        {STATUS_LABEL[agent.status]}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{agent.checkout?.branch}</TableCell>
                    <TableCell className="text-right">
                      {agent.diff ? (
                        <DiffStatChip diff={agent.diff} />
                      ) : (
                        <span className="font-mono text-[11px] text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
}
