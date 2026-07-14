import { useState } from "react";
import type { TaskListReadResult } from "../../lib/pagespace";

interface TaskListViewProps {
  tasks: TaskListReadResult["tasks"];
  availableStatuses: TaskListReadResult["availableStatuses"];
  progress: TaskListReadResult["progress"];
  onStatusChange: (taskId: string, status: string) => Promise<void>;
}

const PRIORITY_COLOR: Record<string, string> = { low: "#5c6472", medium: "#eab308", high: "#f87171" };

// availableStatuses.color is a Tailwind class string (e.g. "bg-slate-100
// text-slate-700 ..."), not a CSS color — this prototype has no Tailwind
// pipeline, so status color is derived from `group` instead of trusting it.
const GROUP_COLOR: Record<string, string> = { todo: "#5c6472", in_progress: "#eab308", done: "#4ade80" };

export function TaskListView({ tasks, availableStatuses, progress, onStatusChange }: TaskListViewProps) {
  const [busyId, setBusyId] = useState<string | null>(null);

  const changeStatus = async (taskId: string, status: string) => {
    setBusyId(taskId);
    try {
      await onStatusChange(taskId, status);
    } finally {
      setBusyId(null);
    }
  };

  const statusMeta = (slug: string) => availableStatuses.find((s) => s.slug === slug);

  return (
    <div className="task-list-view">
      <div className="task-progress">
        <div className="task-progress-bar">
          <div className="task-progress-fill" style={{ width: `${progress.percentage}%` }} />
        </div>
        <span className="muted">{progress.percentage}% complete · {progress.total} task(s)</span>
      </div>

      {tasks.length === 0 && <p className="muted">No tasks yet.</p>}

      <div className="task-rows">
        {tasks.map((task) => {
          const meta = statusMeta(task.status);
          return (
            <div key={task.id} className="task-row">
              <select
                className="task-status-select"
                value={task.status}
                disabled={busyId === task.id}
                onChange={(e) => changeStatus(task.id, e.target.value)}
                style={{ borderColor: GROUP_COLOR[meta?.group ?? "todo"] }}
              >
                {availableStatuses.map((s) => (
                  <option key={s.slug} value={s.slug}>
                    {s.label}
                  </option>
                ))}
              </select>
              <span className="task-title">{task.title}</span>
              <span className="task-priority" style={{ color: PRIORITY_COLOR[task.priority] }}>
                {task.priority}
              </span>
              {task.assignee && <span className="task-assignee">{task.assignee.name ?? "Unknown"}</span>}
              {task.assigneeAgent && <span className="task-assignee">🤖 {task.assigneeAgent.title ?? "Agent"}</span>}
              {task.subTaskCount > 0 && (
                <span className="muted">
                  {task.subTaskCompletedCount}/{task.subTaskCount} sub-tasks
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
