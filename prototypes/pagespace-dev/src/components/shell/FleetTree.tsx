"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { toast } from "sonner";
import {
  ChevronDown,
  ChevronRight,
  FolderGit2,
  GitBranch,
  Plus,
  Server,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { workspaces } from "@/lib/mock/workspaces";
import { agentById } from "@/lib/mock/agents";
import AgentStatusDot from "@/components/fleet/AgentStatusDot";

/**
 * Drive → Workspace → Repo → Branch → agent-leaf tree. Grouping under drive
 * headers matches DevelopmentSidebar's global mode: a MACHINE page lives in a
 * drive's page tree, so the drive is the machine's address — but only its
 * address; the tasks its sessions work can come from any drive. Expansion is
 * decoupled from selection (only agent leaves navigate), and each structural
 * row hover-reveals a `+` spawn affordance (the NodeActionPalette pattern —
 * mocked as a toast for now).
 */
export default function FleetTree() {
  const drives = [...new Map(workspaces.map((ws) => [ws.driveId, ws.driveName])).entries()];
  return (
    <div className="space-y-1 p-1 text-sm">
      {drives.map(([driveId, driveName]) => (
        <div key={driveId} className="space-y-0.5">
          <div className="px-2 pt-1 text-[10px] font-normal uppercase leading-none tracking-wide text-muted-foreground">
            {driveName}
          </div>
          {workspaces
            .filter((ws) => ws.driveId === driveId)
            .map((ws) => (
              <WorkspaceNode key={ws.id} wsId={ws.id} />
            ))}
        </div>
      ))}
    </div>
  );
}

function TreeRow({
  depth,
  expanded,
  onToggleExpand,
  icon,
  label,
  labelClassName,
  trailing,
  onSpawnHere,
}: {
  depth: number;
  expanded?: boolean;
  onToggleExpand?(): void;
  icon: ReactNode;
  label: string;
  labelClassName?: string;
  trailing?: ReactNode;
  onSpawnHere?: string;
}) {
  return (
    <div
      className="group flex items-center gap-1 rounded-sm py-0.5 pr-1 leading-none hover:bg-accent/50"
      style={{ paddingLeft: depth * 14 }}
    >
      {onToggleExpand ? (
        <button
          type="button"
          onClick={onToggleExpand}
          className="shrink-0 rounded-sm p-0.5 hover:bg-accent"
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        </button>
      ) : (
        <span className="size-4 shrink-0" aria-hidden="true" />
      )}
      <button
        type="button"
        onClick={onToggleExpand}
        disabled={!onToggleExpand}
        className={cn("flex min-w-0 flex-1 items-center gap-1.5 text-left", !onToggleExpand && "cursor-default")}
      >
        {icon}
        <span className={cn("truncate text-sm leading-none", labelClassName)}>{label}</span>
      </button>
      {trailing}
      {onSpawnHere && (
        <button
          type="button"
          aria-label={`Spawn agent in ${onSpawnHere}`}
          title={`Spawn agent in ${onSpawnHere}`}
          onClick={() => toast(`Mock: spawn into ${onSpawnHere}`)}
          className="shrink-0 rounded-sm p-0.5 opacity-0 hover:bg-accent group-hover:opacity-100"
        >
          <Plus className="size-3" />
        </button>
      )}
    </div>
  );
}

function WorkspaceNode({ wsId }: { wsId: string }) {
  const ws = workspaces.find((w) => w.id === wsId)!;
  const [expanded, setExpanded] = useState(ws.status === "ready");
  const agentCount = ws.repos.reduce(
    (n, repo) => n + repo.branches.reduce((m, b) => m + b.agentIds.length, 0),
    0,
  );

  return (
    <div>
      <TreeRow
        depth={0}
        expanded={expanded}
        onToggleExpand={() => setExpanded((e) => !e)}
        icon={<Server className="size-3 shrink-0" />}
        label={ws.name}
        trailing={
          <span className="shrink-0 font-mono text-[10px] leading-none text-muted-foreground">
            {ws.status === "ready" ? agentCount || "" : ws.status}
          </span>
        }
        onSpawnHere={ws.name}
      />
      {expanded &&
        ws.repos.map((repo) => (
          <RepoNode key={repo.name} wsName={ws.name} repo={repo.name} branches={repo.branches} />
        ))}
    </div>
  );
}

function RepoNode({
  wsName,
  repo,
  branches,
}: {
  wsName: string;
  repo: string;
  branches: { name: string; agentIds: string[] }[];
}) {
  const [expanded, setExpanded] = useState(true);
  return (
    <div>
      <TreeRow
        depth={1}
        expanded={expanded}
        onToggleExpand={() => setExpanded((e) => !e)}
        icon={<FolderGit2 className="size-3 shrink-0" />}
        label={repo}
        onSpawnHere={`${wsName}/${repo}`}
      />
      {expanded &&
        branches.map((branch) => (
          <BranchNode
            key={branch.name}
            wsName={wsName}
            repo={repo}
            branch={branch.name}
            agentIds={branch.agentIds}
          />
        ))}
      {expanded && branches.length === 0 && (
        <div className="py-0.5 pl-12 text-xs text-muted-foreground">No checkouts</div>
      )}
    </div>
  );
}

function BranchNode({
  wsName,
  repo,
  branch,
  agentIds,
}: {
  wsName: string;
  repo: string;
  branch: string;
  agentIds: string[];
}) {
  const [expanded, setExpanded] = useState(true);
  return (
    <div>
      <TreeRow
        depth={2}
        expanded={agentIds.length > 0 ? expanded : undefined}
        onToggleExpand={agentIds.length > 0 ? () => setExpanded((e) => !e) : undefined}
        icon={<GitBranch className="size-3 shrink-0" />}
        label={branch}
        labelClassName="font-mono text-xs"
        onSpawnHere={`${wsName}/${repo}@${branch}`}
      />
      {expanded && agentIds.map((id) => <AgentLeaf key={id} agentId={id} />)}
    </div>
  );
}

/** The only navigating row — clicking an agent opens its detail pane. */
function AgentLeaf({ agentId }: { agentId: string }) {
  const pathname = usePathname() ?? "";
  const agent = agentById(agentId);
  if (!agent) return null;
  const selected = pathname === `/agents/${agentId}`;

  return (
    <Link
      href={`/agents/${agentId}`}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "flex items-center gap-1.5 rounded-sm py-1 pr-1 leading-none",
        selected ? "bg-accent" : "hover:bg-accent/50",
      )}
      style={{ paddingLeft: 3 * 14 + 4 }}
    >
      <AgentStatusDot status={agent.status} />
      <span className="truncate font-mono text-xs leading-none">{agent.name}</span>
    </Link>
  );
}
