"use client";

import Link from "next/link";
import { toast } from "sonner";
import { Crown, ListTodo, Pause, Play, Send, Skull } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { workspaceById } from "@/lib/mock/workspaces";
import { taskById } from "@/lib/mock/tasks";
import type { Agent } from "@/lib/mock/types";
import AgentStatusDot, { STATUS_LABEL } from "./AgentStatusDot";
import RuntimeBadge from "./RuntimeBadge";
import DiffStatChip from "./DiffStatChip";

export function checkoutLabel(agent: Agent): string {
  if (!agent.checkout) return "root · no checkout";
  const ws = workspaceById(agent.checkout.workspaceId);
  return `${ws?.name ?? agent.checkout.workspaceId} / ${agent.checkout.repo} @ ${agent.checkout.branch}`;
}

/**
 * One agent on the fleet board. The whole card links to the agent; the action
 * row stops propagation so quick actions never navigate.
 */
export default function AgentCard({ agent }: { agent: Agent }) {
  const benched = agent.status === "benched";
  const task = agent.taskId ? taskById(agent.taskId) : undefined;

  return (
    <Link
      href={`/agents/${agent.id}`}
      className={cn(
        "group flex flex-col gap-2.5 rounded-lg border border-border bg-card p-3.5 shadow-[var(--shadow-ambient)] transition-colors hover:border-primary/40",
        agent.isPointGuard && "border-primary/50 bg-primary/[0.04]",
      )}
    >
      <div className="flex items-center gap-2">
        <AgentStatusDot status={agent.status} />
        <span className="truncate font-mono text-sm font-medium">{agent.name}</span>
        {agent.isPointGuard && (
          <span
            className="inline-flex items-center gap-1 rounded-sm bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium leading-none text-primary"
            title="Root agent — orchestrates the fleet"
          >
            <Crown className="size-3" />
            point guard
          </span>
        )}
        <div className="flex-1" />
        <RuntimeBadge runtime={agent.runtime} />
      </div>

      <div className="truncate font-mono text-xs text-muted-foreground">{checkoutLabel(agent)}</div>

      {task && (
        <div
          className="flex items-center gap-1.5 truncate text-xs text-muted-foreground"
          title="The task this agent is grounded on — its spec is the prompt"
        >
          <ListTodo className="size-3 shrink-0 text-info" />
          <span className="truncate">{task.title}</span>
        </div>
      )}

      <div className="rounded-md bg-muted/40 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
        {agent.logTail.map((line, i) => (
          <div key={i} className="truncate">
            {line}
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        {agent.diff ? <DiffStatChip diff={agent.diff} /> : <span className="font-mono text-[11px]">no changes</span>}
        <div className="flex-1" />
        <span>
          {STATUS_LABEL[agent.status].toLowerCase()}
          {agent.exitCode !== undefined && ` (exit ${agent.exitCode})`} · {agent.lastActivityAgo} ago
        </span>
      </div>

      <div
        className="-mx-1 flex items-center gap-0.5 border-t border-[var(--separator)] pt-1.5 opacity-0 transition-opacity group-hover:opacity-100"
        onClick={(e) => e.preventDefault()}
      >
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs"
          onClick={() => toast(`Mock: composing a message to ${agent.name}`)}
        >
          <Send className="size-3" />
          Send
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs"
          onClick={() => toast(`Mock: ${benched ? "resumed" : "benched"} ${agent.name}`)}
        >
          {benched ? <Play className="size-3" /> : <Pause className="size-3" />}
          {benched ? "Play" : "Bench"}
        </Button>
        <div className="flex-1" />
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs text-destructive hover:text-destructive"
            >
              <Skull className="size-3" />
              Kill
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Kill {agent.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                The session ends now. Its checkout and uncommitted changes survive on the workspace.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => toast.success(`Mock: killed ${agent.name}`)}>
                Kill agent
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </Link>
  );
}
