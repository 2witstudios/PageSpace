"use client";

import Link from "next/link";
import { toast } from "sonner";
import { FolderTree, GitCompare, ListTodo, Pause, Play, Settings, Skull, TerminalSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { agentById } from "@/lib/mock/agents";
import { taskById } from "@/lib/mock/tasks";
import AgentStatusDot, { STATUS_LABEL } from "@/components/fleet/AgentStatusDot";
import RuntimeBadge from "@/components/fleet/RuntimeBadge";
import { checkoutLabel } from "@/components/fleet/AgentCard";
import TerminalPaneGrid from "./TerminalPaneGrid";
import FilesPanel from "./FilesPanel";
import DiffPanel from "./DiffPanel";
import SettingsPanel from "./SettingsPanel";

// Same four tabs, same order, as MachineView — this app is that surface, abstracted.
const TAB_TRIGGERS = [
  { value: "terminal", label: "Terminal", icon: TerminalSquare },
  { value: "files", label: "Files", icon: FolderTree },
  { value: "diff", label: "Diff", icon: GitCompare },
  { value: "settings", label: "Settings", icon: Settings },
] as const;

export default function AgentDetail({ agentId }: { agentId: string }) {
  const agent = agentById(agentId);

  if (!agent) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <TerminalSquare className="size-10 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Agent not found</h2>
        <p className="text-sm text-muted-foreground">It may have been killed and cleaned.</p>
      </div>
    );
  }

  const benched = agent.status === "benched";
  const task = agent.taskId ? taskById(agent.taskId) : undefined;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 border-b border-[var(--separator)] px-4 py-2.5">
        <AgentStatusDot status={agent.status} />
        <span className="font-mono text-sm font-semibold">{agent.name}</span>
        <RuntimeBadge runtime={agent.runtime} />
        <span className="hidden truncate font-mono text-xs text-muted-foreground sm:inline">
          {checkoutLabel(agent)}
        </span>
        {task && (
          <Link
            href="/tasks"
            className="hidden max-w-64 shrink items-center gap-1 truncate rounded-sm border border-border bg-muted/40 px-1.5 py-0.5 text-[11px] leading-none text-muted-foreground hover:border-primary/40 hover:text-foreground lg:inline-flex"
            title={task.spec ?? task.title}
          >
            <ListTodo className="size-3 shrink-0 text-info" />
            <span className="truncate">{task.title}</span>
          </Link>
        )}
        <div className="flex-1" />
        <span className="hidden text-xs text-muted-foreground lg:inline">
          {STATUS_LABEL[agent.status]} · spawned {agent.spawnedAgo} ago
        </span>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={() => toast(`Mock: ${benched ? "resumed" : "benched"} ${agent.name}`)}
        >
          {benched ? <Play className="size-3" /> : <Pause className="size-3" />}
          {benched ? "Play" : "Bench"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-xs text-destructive hover:text-destructive"
          onClick={() => toast(`Mock: killed ${agent.name}`)}
        >
          <Skull className="size-3" />
          Kill
        </Button>
      </div>

      <Tabs defaultValue="terminal" className="flex min-h-0 flex-1 flex-col gap-0">
        <div className="border-b border-border px-2 py-1.5">
          <TabsList className="h-auto bg-transparent p-0">
            {TAB_TRIGGERS.map(({ value, label, icon: Icon }) => (
              <TabsTrigger
                key={value}
                value={value}
                aria-label={label}
                title={label}
                className={cn(
                  "gap-1.5 px-2.5 py-1.5 text-muted-foreground sm:px-3",
                  "data-[state=active]:bg-muted data-[state=active]:text-foreground",
                )}
              >
                <Icon className="size-4" />
                <span className="hidden sm:inline">{label}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        <TabsContent value="terminal" className="min-h-0 flex-1 outline-none">
          <TerminalPaneGrid agent={agent} />
        </TabsContent>
        <TabsContent value="files" className="min-h-0 flex-1 outline-none">
          <FilesPanel agent={agent} />
        </TabsContent>
        <TabsContent value="diff" className="min-h-0 flex-1 overflow-y-auto outline-none">
          <DiffPanel agentId={agent.id} branch={agent.checkout?.branch} />
        </TabsContent>
        <TabsContent value="settings" className="min-h-0 flex-1 overflow-y-auto outline-none">
          <SettingsPanel agent={agent} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
