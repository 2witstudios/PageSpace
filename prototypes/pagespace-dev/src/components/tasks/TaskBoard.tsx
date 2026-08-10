"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Bot, ChevronDown, ChevronRight, RefreshCw, User, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { agentById } from "@/lib/mock/agents";
import { flattenList } from "@/lib/mock/tasks";
import type { TaskAssignee, TaskItem, TaskList, TaskPriority, TaskStatusConfig } from "@/lib/mock/types";
import AgentStatusDot from "@/components/fleet/AgentStatusDot";

/** Mirrors the real board's PRIORITY_CONFIG chips. */
const PRIORITY_CONFIG: Record<TaskPriority, { label: string; color: string }> = {
  low: { label: "Low", color: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400" },
  medium: { label: "Medium", color: "bg-amber-100 text-amber-600 dark:bg-amber-900 dark:text-amber-400" },
  high: { label: "High", color: "bg-red-100 text-red-600 dark:bg-red-900 dark:text-red-400" },
};

type StatusOf = (task: TaskItem) => string;
type SetStatus = (taskId: string, slug: string) => void;

const configFor = (slug: string, configs: TaskStatusConfig[]) =>
  configs.find((c) => c.slug === slug);

const isDoneSlug = (slug: string, configs: TaskStatusConfig[]) =>
  configFor(slug, configs)?.group === "done";

/** canExpandTask, same rule as the real board: content or sub-tasks. */
const canExpand = (task: TaskItem) =>
  task.hasContent || (task.childLists ?? []).some((l) => l.tasks.length > 0);

/** Live sub-task counts (direct child lists), against the board's local statuses. */
function subCounts(task: TaskItem, statusOf: StatusOf): { total: number; completed: number } {
  const lists = task.childLists ?? [];
  const total = lists.reduce((n, l) => n + l.tasks.length, 0);
  const completed = lists.reduce(
    (n, l) => n + l.tasks.filter((t) => isDoneSlug(statusOf(t), l.statusConfigs)).length,
    0,
  );
  return { total, completed };
}

function AssigneeChip({ assignee }: { assignee: TaskAssignee }) {
  if (assignee.kind === "session") {
    const agent = agentById(assignee.id);
    return (
      <Link
        href={`/agents/${assignee.id}`}
        onClick={(e) => e.stopPropagation()}
        title={`Cloud session: ${assignee.label}`}
        className="inline-flex items-center gap-1 rounded-sm border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted-foreground hover:border-primary/40 hover:text-foreground"
      >
        {agent && <AgentStatusDot status={agent.status} className="size-1.5" />}
        {assignee.label}
      </Link>
    );
  }
  const Icon = assignee.kind === "agent-page" ? Bot : User;
  return (
    <span
      title={assignee.kind === "agent-page" ? `Agent page: ${assignee.label}` : assignee.label}
      className="inline-flex items-center gap-1 rounded-sm bg-muted/60 px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground"
    >
      <Icon className="size-3" />
      {assignee.label}
    </span>
  );
}

function StatusChip({
  slug,
  configs,
  onChange,
}: {
  slug: string;
  configs: TaskStatusConfig[];
  onChange: (slug: string) => void;
}) {
  const config = configFor(slug, configs);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "rounded-full px-2 py-0.5 text-[11px] font-medium leading-4 outline-none",
          config?.color ?? "bg-muted text-muted-foreground",
        )}
      >
        {config?.name ?? slug}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {[...configs]
          .sort((a, b) => a.position - b.position)
          .map((c) => (
            <DropdownMenuItem key={c.slug} onClick={() => onChange(c.slug)} className="gap-2 text-xs">
              <span className={cn("rounded-full px-1.5 py-0.5 text-[10px] leading-none", c.color)}>{c.name}</span>
            </DropdownMenuItem>
          ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TaskRow({
  task,
  configs,
  depth,
  statusOf,
  setStatus,
}: {
  task: TaskItem;
  configs: TaskStatusConfig[];
  depth: number;
  statusOf: StatusOf;
  setStatus: SetStatus;
}) {
  const [expanded, setExpanded] = useState(false);
  const slug = statusOf(task);
  const done = isDoneSlug(slug, configs);
  const { total, completed } = subCounts(task, statusOf);

  // The real board's completion gate, verbatim behavior: a parent with open
  // sub-tasks refuses the checkbox.
  const toggleComplete = useCallback(() => {
    if (done) {
      const todo = configs.find((c) => c.group === "todo");
      if (todo) setStatus(task.id, todo.slug);
      return;
    }
    if (total > 0 && completed < total) {
      const pending = total - completed;
      toast.error(`Finish ${pending} sub-task${pending > 1 ? "s" : ""} first`);
      return;
    }
    const doneConfig = configs.find((c) => c.group === "done");
    if (doneConfig) setStatus(task.id, doneConfig.slug);
  }, [done, total, completed, configs, setStatus, task.id]);

  return (
    <div>
      <div
        className="flex items-center gap-2 border-b border-[var(--separator)] py-1.5 pr-2 hover:bg-accent/30"
        style={{ paddingLeft: 8 + depth * 20 }}
      >
        <Checkbox checked={done} onCheckedChange={toggleComplete} aria-label={`Complete ${task.title}`} />
        {canExpand(task) ? (
          <button
            type="button"
            aria-label={expanded ? "Collapse" : "Expand"}
            onClick={() => setExpanded((e) => !e)}
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </button>
        ) : (
          <span className="inline-block w-[14px] shrink-0" />
        )}

        <button
          type="button"
          onClick={() => toast(`Mock: opens the task's page (${task.pageId})`)}
          className={cn(
            "min-w-0 truncate text-left text-sm hover:text-primary hover:underline",
            done && "text-muted-foreground line-through",
          )}
        >
          {task.title}
        </button>

        {total > 0 && (
          <span
            className="shrink-0 font-mono text-[10px] text-muted-foreground"
            title="Sub-tasks — the parent can't complete while any are open"
          >
            {completed}/{total}
          </span>
        )}
        {task.loop && (
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-info/10 px-1.5 py-0.5 font-mono text-[10px] leading-none text-info"
            title={`Loops until: ${task.loop.until}`}
          >
            <RefreshCw className="size-3" />
            loop {task.loop.iteration}
          </span>
        )}
        {(task.activeTriggerCount ?? 0) > 0 && (
          <span
            className="inline-flex shrink-0 items-center gap-0.5 font-mono text-[10px] text-warning"
            title={`${task.activeTriggerCount} active trigger${task.activeTriggerCount === 1 ? "" : "s"}`}
          >
            <Zap className="size-3" />
            {task.activeTriggerCount}
          </span>
        )}

        <div className="min-w-0 flex-1" />

        <div className="flex shrink-0 items-center gap-1">
          {task.assignees.map((a) => (
            <AssigneeChip key={`${a.kind}-${a.id}`} assignee={a} />
          ))}
        </div>
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium leading-4",
            PRIORITY_CONFIG[task.priority].color,
          )}
        >
          {PRIORITY_CONFIG[task.priority].label}
        </span>
        <StatusChip slug={slug} configs={configs} onChange={(s) => setStatus(task.id, s)} />
      </div>

      {expanded && (
        <div className="border-b border-[var(--separator)] bg-muted/20" style={{ paddingLeft: 8 + (depth + 1) * 20 }}>
          {task.spec && (
            <p className="max-w-2xl py-2 pr-4 font-mono text-[11px] leading-relaxed text-muted-foreground">
              {task.spec}
            </p>
          )}
          {(task.childLists ?? []).map((list) => (
            <NestedList key={list.id} list={list} statusOf={statusOf} setStatus={setStatus} />
          ))}
        </div>
      )}
    </div>
  );
}

/** A nested TASK_LIST page inside a task's page — its own title and status configs. */
function NestedList({
  list,
  statusOf,
  setStatus,
}: {
  list: TaskList;
  statusOf: StatusOf;
  setStatus: SetStatus;
}) {
  return (
    <div className="pb-2">
      <div className="py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {list.title}
      </div>
      <div className="rounded-md border border-[var(--separator)] bg-background/40">
        {list.tasks.map((task) => (
          <TaskRow key={task.id} task={task} configs={list.statusConfigs} depth={0} statusOf={statusOf} setStatus={setStatus} />
        ))}
      </div>
    </div>
  );
}

function KanbanView({
  list,
  statusOf,
  setStatus,
}: {
  list: TaskList;
  statusOf: StatusOf;
  setStatus: SetStatus;
}) {
  const columns = [...list.statusConfigs].sort((a, b) => a.position - b.position);
  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {columns.map((col) => {
        const tasks = list.tasks.filter((t) => statusOf(t) === col.slug);
        return (
          <div key={col.slug} className="w-60 shrink-0 rounded-lg border border-border bg-card/60 p-2">
            <div className="flex items-center gap-2 px-1 pb-2">
              <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium leading-4", col.color)}>{col.name}</span>
              <span className="font-mono text-[10px] text-muted-foreground">{tasks.length}</span>
            </div>
            <div className="space-y-2">
              {tasks.map((task) => (
                <div key={task.id} className="rounded-md border border-border bg-card p-2.5 shadow-[var(--shadow-ambient)]">
                  <div className="text-xs">{task.title}</div>
                  <div className="mt-2 flex items-center gap-1">
                    {task.assignees.map((a) => (
                      <AssigneeChip key={`${a.kind}-${a.id}`} assignee={a} />
                    ))}
                    <div className="flex-1" />
                    <span className={cn("rounded-full px-1.5 py-0.5 text-[9px] font-medium leading-none", PRIORITY_CONFIG[task.priority].color)}>
                      {PRIORITY_CONFIG[task.priority].label}
                    </span>
                  </div>
                  <StatusChangeRow task={task} configs={list.statusConfigs} setStatus={setStatus} statusOf={statusOf} />
                </div>
              ))}
              {tasks.length === 0 && (
                <div className="py-4 text-center text-[11px] text-muted-foreground">Empty</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function StatusChangeRow({
  task,
  configs,
  statusOf,
  setStatus,
}: {
  task: TaskItem;
  configs: TaskStatusConfig[];
  statusOf: StatusOf;
  setStatus: SetStatus;
}) {
  return (
    <div className="mt-2">
      <StatusChip slug={statusOf(task)} configs={configs} onChange={(s) => setStatus(task.id, s)} />
    </div>
  );
}

/**
 * One TASK_LIST page rendered the way the real board renders it: list rows
 * (checkbox · expand · title · sub-count · trigger ⚡ · assignees · priority ·
 * status chip) with expansion into the task's page (spec + nested lists), or
 * kanban columns from the list's own status order. Status changes and the
 * "Finish N sub-tasks first" completion gate work against local state so the
 * behavior is demonstrable.
 */
export default function TaskBoard({ list }: { list: TaskList }) {
  const [view, setView] = useState<"list" | "board">("list");
  const [statuses, setStatuses] = useState<Record<string, string>>(() =>
    Object.fromEntries(flattenList(list).map((t) => [t.id, t.status])),
  );

  const statusOf = useCallback<StatusOf>((task) => statuses[task.id] ?? task.status, [statuses]);
  const setStatus = useCallback<SetStatus>((taskId, slug) => {
    setStatuses((prev) => ({ ...prev, [taskId]: slug }));
  }, []);

  const doneCount = useMemo(
    () => list.tasks.filter((t) => isDoneSlug(statusOf(t), list.statusConfigs)).length,
    [list, statusOf],
  );

  return (
    <section className="rounded-lg border border-border bg-card shadow-[var(--shadow-ambient)]">
      <header className="flex items-center gap-2 border-b border-[var(--separator)] px-3 py-2">
        <span className="text-sm font-semibold">{list.title}</span>
        <span className="font-mono text-[10px] text-muted-foreground">
          {doneCount}/{list.tasks.length} done
        </span>
        {list.description && (
          <span className="hidden truncate text-[11px] text-muted-foreground md:inline">— {list.description}</span>
        )}
        <div className="flex-1" />
        <div className="flex rounded-md border border-border p-0.5">
          {(["list", "board"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={cn(
                "rounded-sm px-2 py-0.5 text-[11px] capitalize",
                view === v ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {v}
            </button>
          ))}
        </div>
      </header>

      <div className={cn(view === "board" && "p-3")}>
        {view === "list" ? (
          list.tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              configs={list.statusConfigs}
              depth={0}
              statusOf={statusOf}
              setStatus={setStatus}
            />
          ))
        ) : (
          <KanbanView list={list} statusOf={statusOf} setStatus={setStatus} />
        )}
      </div>
    </section>
  );
}
