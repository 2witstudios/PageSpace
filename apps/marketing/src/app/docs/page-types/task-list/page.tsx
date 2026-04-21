import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Task Lists",
  description: "How Task List pages work in PageSpace — table and kanban views, custom statuses, multi-assignee tasks, and AI agents that pick up their own work.",
  path: "/docs/page-types/task-list",
  keywords: ["task lists", "kanban", "project management", "AI agents", "assignees", "due dates"],
});

const content = `
# Task Lists

A Task List is a page type for structured work. Each list has its own status columns, priority levels, and assignees — and the assignees can be AI agents as well as people.

## What you can do

- Create a Task List from the page tree — the same way you create any other page.
- Switch between two views from the header: a **Table view** for scanning and editing inline, and a **Kanban view** grouped by status.
- Add tasks with a title, priority (Low, Medium, or High), due date, and notes.
- Assign as many people or AI agents to a task as you need — a task can have several humans and several agents on it at once.
- Define your own statuses per list. Rename them, pick a color, and choose whether each one counts as Not Started, In Progress, or Done.
- Drag tasks to reorder them in the Table view, or drag them across columns in the Kanban view to change status.
- Open the linked document for any task to keep notes, research, or a working doc tied to the task itself.
- Schedule an AI agent to run when a task hits its due date or gets marked done — useful for follow-ups, check-ins, or handoffs.
- See everything assigned to you across every [drive](/docs/features/drives) at **My Tasks**, or filter a single drive's tasks from its Tasks view.
- Watch updates land live — when a teammate or agent changes a status, your board reflects it without a refresh.

## How it works

Every task on a Task List page gets its own child Document page underneath it. The task row you see in the table is the surface; the Document page is where notes, attachments, and longer thinking go. Renaming the task renames the page, and deleting the task trashes the page.

Each Task List owns its statuses. When you first open a list, you get a standard set — **To Do**, **In Progress**, **Blocked**, **Done** — and you can add, rename, recolor, or delete statuses from there. Every status belongs to one of three groups: Not Started, In Progress, or Done. The group is what the checkbox and completion counters actually look at, so a custom status like "Awaiting review" still counts as In Progress if you put it in that group.

Assignees are kept in a separate list per task, so adding and removing people or agents doesn't disturb anyone else on the task. An AI agent assigned to a task is the same AI Chat page you already have in your workspace — agents can see their own assignments, pick up work, change status, and post updates, using the same tools they'd use anywhere else.

Agent triggers sit on top of that. When you attach one to a task, you pick an agent, write a short prompt (or point at a page that already has the instructions), and choose whether it fires when the due date arrives or when the task gets marked done. When the trigger fires, the agent runs with that prompt plus any pages you flagged as context.

Reordering uses the page tree. Because each task is backed by a Document page, dragging a task up or down changes the underlying page's position, so the order you see in the list is the same order you see in the sidebar.

## What it doesn't do

- **No recurring tasks.** A task fires once. If you want a weekly check-in, schedule it from the Calendar, or build the recurrence into a triggered agent that creates the next task.
- **No subtasks or dependencies.** The list is flat. You can't mark one task as "blocked by" another, and you can't nest a task under another task. Group related work in a folder instead, or put the breakdown in the task's linked document.
- **No time tracking.** There's no estimated hours field, no time log, and no burndown chart. Due dates are a single timestamp, not a range.
- **No comments thread on the task row.** Discussion lives in the linked document or in a Channel — the task itself only carries the title, description, and metadata.
- **Agent trigger prompts cap at 10,000 characters, and you can attach at most 10 context pages.** If you need more, point the trigger at an instruction page instead of pasting the prompt inline.
- **You can't reorder statuses from the configuration panel.** You can add, rename, recolor, regroup, and delete them, but the order is fixed by creation order.

## Related

- [Pages](/docs/features/pages) — every task is backed by a Document page, and Task Lists follow the same permissions, sharing, and trash rules as any other page.
- [AI in your Workspace](/docs/features/ai) — how agents pick up assigned work and run on triggers.
- [Channels](/docs/page-types/channel) — where task discussion usually happens.
- [Page Types overview](/docs/page-types) — the full list of page types alongside Task List.
`;

export default function HowItWorksTaskListsPage() {
  return <DocsMarkdown content={content} />;
}
