"use client";

import { boards } from "@/lib/mock/tasks";
import TaskBoard from "@/components/tasks/TaskBoard";

/**
 * Tasks — real PageSpace boards, not a bespoke tree. Each section is a
 * TASK_LIST page in a drive, rendered with the actual board grammar: status
 * chips from per-list configs, priority chips, user/agent/session assignees,
 * trigger counts, page-backed expansion into nested lists, and the "Finish N
 * sub-tasks first" completion gate.
 *
 * Boards are grouped by DRIVE — and deliberately not by machine: where a task
 * lives (drive → page tree) and where it gets executed (machine → project →
 * branch) are independent hierarchies, joined only when a session is assigned
 * (DESIGN.md §2.7).
 */
export default function TasksPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      {boards.map(({ driveName, list }) => (
        <div key={list.id} className="space-y-2">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {driveName}
          </div>
          <TaskBoard list={list} />
        </div>
      ))}
    </div>
  );
}
