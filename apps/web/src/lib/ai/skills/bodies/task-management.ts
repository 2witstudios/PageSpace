/**
 * task-management skill body — code-shipped instructions for running task
 * workflows on TASK_LIST pages. Loaded on demand via load_skill / the
 * /task-management chip; keep in sync with the task tools and helpers.
 */
export const TASK_MANAGEMENT_SKILL_BODY = `# Task Management

You are working with tasks on TASK_LIST pages. This skill covers the data model, the tools, and the workflows that are easy to get wrong.

## The data model

- A **TASK_LIST page** is a task list. Tasks on it are separate task rows, each linked one-to-one to its own **auto-created child TASK_LIST page**.
- That linked child page holds the task's **description and its sub-tasks**. Its title is kept in sync with the task title (the page is the single source of truth for the title — renaming via \`update_task\` writes through to the page).
- Because each task's linked page is itself a TASK_LIST page, **tasks nest to any depth**: to add a sub-task, call \`create_task\` with \`pageId\` set to the parent task's linked page id.
- **Never trash or delete a task's linked page directly.** Use \`delete_task\`, which trashes the linked page and hard-deletes the task row together (and disables any attached triggers). Deleting the page alone strands the task row and its triggers.
- Every task has **two ids**: the task id (\`taskId\` — what \`update_task\`, \`delete_task\`, \`reorder_task\`, and \`set_task_trigger\` take) and the linked page id (\`pageId\` — what \`create_task\` takes as the destination for sub-tasks). Tool responses return both; do not confuse them.

## Read before you mutate

Always \`read_page\` the TASK_LIST page before creating or updating tasks. It returns the existing tasks (with their taskIds and pageIds), the list structure, and \`availableStatuses\` — the status slugs valid on this list. Mutating blind risks duplicate tasks, invalid status slugs, and clobbering structure the user already set up.

## The tools

- \`create_task\` — create a task on a TASK_LIST page (never \`update_task\` with no taskId).
- \`update_task\` — update fields of an existing task by taskId: title, status, priority, assignees, dueDate, note, agentTrigger.
- \`delete_task\` — hard-delete a task and trash its linked page.
- \`reorder_task\` — move a task to a new index in its list.
- \`get_assigned_tasks\` — list tasks assigned to an agent (defaults to you when you run as an agent).
- \`create_task_status\` — add a custom status slug to a list.
- \`set_task_trigger\` / \`delete_task_trigger\` — attach/remove agent triggers on existing tasks.

Create, update, delete, and reorder are separate verbs — none of them infers another's behavior.

## Statuses

- Each task list has its own status configuration. Defaults, auto-created on first use: \`pending\` (To Do), \`in_progress\`, \`blocked\`, \`completed\` (Done).
- Every status slug belongs to a **semantic group** — \`todo\`, \`in_progress\`, or \`done\` — and the group, not the slug name, controls behavior. Any status in the \`done\` group marks the task completed (sets \`completedAt\`); moving to a non-done status clears it. Note \`blocked\` is in the \`in_progress\` group.
- Status values are validated: passing a slug not configured on the list fails with the valid slugs listed. Use an existing slug from \`availableStatuses\` whenever one fits.
- To add a new status (e.g. "In Review"), call \`create_task_status\` **before** using it in \`create_task\`/\`update_task\`. The slug is auto-generated from the name ("In Review" → \`in_review\`) and returned to you; a duplicate slug on the same list is rejected. You need edit permission on the list. Only create a status when no existing one fits.
- List rollup is automatic: when every task on a list reaches a done-group status the list itself is marked completed; a task entering an in-progress-group status moves a pending list to in_progress. Don't manage list status by hand.

## Completion and SUBTASKS_INCOMPLETE

A task **cannot be marked done while it still has incomplete sub-tasks** (non-trashed tasks on its linked page). When a completion attempt is blocked, the tool returns:

\`\`\`json
{ "success": false, "code": "SUBTASKS_INCOMPLETE", "error": "...", "pending": N, "total": M }
\`\`\`

**Do not retry the same call — it is deterministic and will fail again.** Instead: tell the user that {pending} of {total} sub-tasks remain, and either complete/delete those sub-tasks first (recursively — they have the same guard) or leave the parent open. Leaf tasks with no sub-tasks always pass.

Completing a task (from a not-completed state) also cancels any pending due-date trigger on it and fires its completion trigger, if one exists.

## Assignees

- Tasks can be assigned to **users and AI agents** (agents are AI_CHAT pages), including multiple of each at once.
- Preferred: the \`assigneeIds\` array — each entry \`{ "type": "user" | "agent", "id": "..." }\`. Passing the array is a **full replace** of all assignees; pass \`[]\` to clear everyone. Legacy \`assigneeId\` (user) / \`assigneeAgentId\` (agent) set a single assignee; \`null\` unassigns.
- An assigned agent must be an AI_CHAT page **in the same drive** as the task list; anything else is rejected.
- Assigning a task to an agent puts it on that agent's workload: the agent (you included) sees it via \`get_assigned_tasks\`. Assignment alone does not run the agent — to make an agent act at a time or on completion, attach a trigger (below). Agents may assign tasks to themselves or to other agents to coordinate work.
- \`get_assigned_tasks\` defaults to the current agent when you run in agent context; filter by \`agentId\`, \`status\`, or \`driveId\`. Completed tasks are **excluded by default** — pass \`includeCompleted: true\` to see them. Results are grouped by status group (todo / in_progress / done).

## Due dates

- \`dueDate\` takes an ISO 8601 string; \`null\` clears it.
- Setting, changing, or clearing a due date automatically syncs any due-date trigger on the task. Completing the task before the due date cancels the pending due-date trigger.
- A \`due_date\` trigger cannot be attached to a task that has no due date — set the due date first via \`update_task\`.

## Triggers — automated and recurring follow-ups

Task triggers schedule an AI agent to run off a task. Two trigger types:

- \`due_date\` — the agent runs when the task's due date arrives (task must already have a due date).
- \`completion\` — the agent runs when the task is marked done.

**Prefer \`set_task_trigger\`** for existing tasks: flat schema, explicit intent. Calling it again with the same taskId + triggerType **replaces** the existing trigger (upsert; one trigger per type per task). The \`agentTrigger\` parameter on \`create_task\`/\`update_task\` is a shortcut for setting the trigger in the same call.

Trigger payload:

- \`agentPageId\` (required) — the AI_CHAT page to execute; must be in the same drive as the task list and not trashed.
- \`prompt\` (max 10,000 chars) or \`instructionPageId\` — **at least one is required**; the instructions the agent receives when it runs.
- \`contextPageIds\` — up to 10 page ids included as reference context; all must be in the same drive and not trashed.

Constraints: the task list must be drive-based, and you need edit access to it. \`delete_task_trigger\` (taskId + triggerType) disables a trigger and is idempotent — safe to call even if none exists.

**Recurring workflows:** when the user wants something to happen repeatedly (e.g. "every time this is done, create next week's task"), propose a trigger instead of doing it once manually. A \`completion\` trigger whose prompt tells the agent to create the follow-up task (optionally with its own trigger) produces a self-sustaining recurring loop. After setting any trigger, tell the user what will run, when, and what context the agent will receive.

## Reordering

- \`reorder_task\` moves a task to a 0-based target index; out-of-range values are clamped. Peer ordering is stored on the linked pages' positions — the same rail users drag in the UI — so your reorder and a user's drag can never disagree.
- To create a task at a specific slot, pass \`position\` to \`create_task\` instead of creating then reordering.

## Notes and metadata

The \`note\` field on \`create_task\`/\`update_task\` records a short annotation in task metadata (status changes log the from → to transition alongside it). Longer descriptions belong in the task's linked page content, not in notes.

## Common pitfalls

- **Don't** call \`update_task\` without a \`taskId\` to create a task — it fails; use \`create_task\`.
- **Don't** delete or trash a task's linked child page directly — use \`delete_task\`.
- **Don't** retry a \`SUBTASKS_INCOMPLETE\` failure — resolve the sub-tasks first.
- **Don't** invent status slugs — read \`availableStatuses\`, or \`create_task_status\` first.
- **Don't** mix up taskId and pageId — mutation tools take taskId; \`create_task\` and \`create_task_status\` take the TASK_LIST pageId.
- Empty or whitespace-only titles are rejected on create and rename.
- "Linked page was modified concurrently" means a revision conflict — re-read and retry the mutation once; it is not a permission error.
- Agent assignees and trigger agents must live in the same drive as the task list; cross-drive references are rejected.
`;
