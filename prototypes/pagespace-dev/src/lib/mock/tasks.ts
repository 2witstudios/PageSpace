import type { TaskItem, TaskList, TaskStatusConfig, TaskStatusGroup } from "./types";

/**
 * Fixtures in the REAL board shape: TASK_LIST pages in drives, tasks backed by
 * pages, nesting via child TASK_LIST pages inside a task's page, per-list
 * status configs. Colors are the exact DEFAULT_TASK_STATUSES strings from
 * packages/db/src/schema/tasks.ts.
 *
 * Note the deliberate hierarchy split (DESIGN.md §2.7): the pagespace-cli
 * drive's docs task is worked by a session on `orbit`, a machine whose MACHINE
 * page lives in the PageSpace drive — the task's drive and the checkout's
 * drive are independent coordinates, joined only by assignment.
 */
export const DEFAULT_STATUSES: TaskStatusConfig[] = [
  { slug: "pending", name: "To Do", color: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300", group: "todo", position: 0 },
  { slug: "in_progress", name: "In Progress", color: "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300", group: "in_progress", position: 1 },
  { slug: "blocked", name: "Blocked", color: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300", group: "in_progress", position: 2 },
  { slug: "completed", name: "Done", color: "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300", group: "done", position: 3 },
];

/** The Features list customizes its statuses — per-list configs are the point. */
const FEATURES_STATUSES: TaskStatusConfig[] = [
  ...DEFAULT_STATUSES.slice(0, 3),
  { slug: "in_review", name: "In Review", color: "bg-sky-100 text-sky-700 dark:bg-sky-900 dark:text-sky-300", group: "in_progress", position: 3 },
  { ...DEFAULT_STATUSES[3], position: 4 },
];

const t5PhaseList: TaskList = {
  id: "tl-t5",
  pageId: "pg-t5",
  driveId: "drv-pagespace",
  title: "T5 — after() fan-out → executeWorkflow",
  statusConfigs: DEFAULT_STATUSES,
  tasks: [
    {
      id: "t-t5-red",
      pageId: "pg-t5-red",
      title: "RED — failing test: one workflow per trigger row",
      status: "completed",
      priority: "high",
      assignees: [{ kind: "session", id: "ag-webhooks", label: "webhooks-fanout" }],
      hasContent: true,
      spec: "Given a verified webhook event with N trigger rows, should observe N executeWorkflow calls (test written, run, and red before GREEN begins).",
    },
    {
      id: "t-t5-green",
      pageId: "pg-t5-green",
      title: "GREEN — implement fanOut with after()",
      status: "in_progress",
      priority: "high",
      assignees: [{ kind: "session", id: "ag-webhooks", label: "webhooks-fanout" }],
      activeTriggerCount: 1,
      hasContent: true,
      spec: "Given the red test, should dispatch N workflow executions off-response via after(), skipping rows whose page type has no handler. Every fanOut branch covered.",
    },
  ],
};

const webhooksEpicList: TaskList = {
  id: "tl-webhooks",
  pageId: "pg-webhooks-epic",
  driveId: "drv-pagespace",
  title: "Phases",
  statusConfigs: DEFAULT_STATUSES,
  tasks: [
    {
      id: "t-t4",
      pageId: "pg-t4",
      title: "T4 — per-page-type dispatch map",
      status: "completed",
      priority: "medium",
      assignees: [],
      hasContent: true,
      spec: "Given a webhook event, should route it through a per-page-type dispatch map (CHANNEL handler + no-action bookkeeping).",
    },
    {
      id: "t-t5",
      pageId: "pg-t5",
      title: "T5 — after() fan-out → executeWorkflow",
      status: "in_progress",
      priority: "high",
      assignees: [{ kind: "session", id: "ag-webhooks", label: "webhooks-fanout" }],
      hasContent: true,
      spec: "Given a verified webhook event with N trigger rows, should dispatch N workflow executions off-response via after().",
      childLists: [t5PhaseList],
    },
    {
      id: "t-t6",
      pageId: "pg-t6",
      title: "T6 — retry bookkeeping on failed dispatch",
      status: "blocked",
      priority: "medium",
      assignees: [],
      activeTriggerCount: 1,
      hasContent: true,
      spec: "Given a workflow execution that throws, should record the failure on the trigger row and schedule one retry with backoff. Blocked until T5 merges — same files.",
    },
  ],
};

const authFixList: TaskList = {
  id: "tl-authfix",
  pageId: "pg-authfix",
  driveId: "drv-pagespace",
  title: "RED/GREEN",
  statusConfigs: DEFAULT_STATUSES,
  tasks: [
    {
      id: "t-auth-red",
      pageId: "pg-auth-red",
      title: "RED — AuthProvider keeps grace across refresh",
      status: "completed",
      priority: "high",
      assignees: [{ kind: "session", id: "ag-authfix", label: "fix-auth-refresh" }],
      hasContent: true,
      spec: "Given a device token mid-grace-window, should observe revokeTokenAfterGrace (not instant revoke) across a token refresh.",
    },
    {
      id: "t-auth-green",
      pageId: "pg-auth-green",
      title: "GREEN — revokeTokenAfterGrace on the refresh path",
      status: "in_progress",
      priority: "high",
      assignees: [{ kind: "session", id: "ag-authfix", label: "fix-auth-refresh" }],
      hasContent: true,
      spec: "Given the red test, should revoke the old token only after the device grace window on refresh.",
    },
  ],
};

const sheetviewList: TaskList = {
  id: "tl-sheetview",
  pageId: "pg-sheetview-epic",
  driveId: "drv-pagespace",
  title: "Extractions",
  statusConfigs: DEFAULT_STATUSES,
  tasks: [
    {
      id: "t-sv-toolbar",
      pageId: "pg-sv-toolbar",
      title: "Extract — SheetToolbar as a pure component",
      status: "completed",
      priority: "medium",
      assignees: [],
      hasContent: false,
    },
    {
      id: "t-sv-grid",
      pageId: "pg-sv-grid",
      title: "Extract — SheetGridBody + formula bar",
      status: "in_progress",
      priority: "medium",
      assignees: [{ kind: "session", id: "ag-sheetview", label: "sheetview-decompose" }],
      hasContent: true,
      spec: "Given SheetView's render body, should extract SheetGridBody and the formula bar as pure components with useEditingStore registration preserved.",
    },
    {
      id: "t-sv-core",
      pageId: "pg-sv-core",
      title: "Extract — selection model into a pure module",
      status: "pending",
      priority: "low",
      assignees: [],
      hasContent: true,
      spec: "Given the inline selection reducer, should land it as a pure function module with 100% branch coverage.",
    },
  ],
};

/** The drive's top-level Features board — what /tasks shows. */
export const featuresList: TaskList = {
  id: "tl-features",
  pageId: "pg-features",
  driveId: "drv-pagespace",
  title: "Features",
  description: "PageSpace drive · task list page — epics expand into their pages' nested lists.",
  statusConfigs: FEATURES_STATUSES,
  tasks: [
    {
      id: "t-webhooks",
      pageId: "pg-webhooks-epic",
      title: "Webhooks — Page Webhooks (universal)",
      status: "in_progress",
      priority: "high",
      assignees: [{ kind: "user", id: "u-jono", label: "Jono" }],
      hasContent: true,
      spec: "Universal incoming/outgoing webhooks for any page type; epic closes when every phase is merged.",
      childLists: [webhooksEpicList],
    },
    {
      id: "t-auth",
      pageId: "pg-authfix",
      title: "Auth — desktop logout regression",
      status: "in_review",
      priority: "high",
      assignees: [
        { kind: "user", id: "u-jono", label: "Jono" },
        { kind: "session", id: "ag-authfix", label: "fix-auth-refresh" },
      ],
      activeTriggerCount: 1,
      hasContent: true,
      spec: "Desktop logs out on token refresh. Two candidate causes: instant-revoke (#2084) or the device-token grace clobber.",
      childLists: [authFixList],
    },
    {
      id: "t-coverage",
      pageId: "pg-coverage",
      title: "Coverage — packages/lib pure modules to 100%",
      status: "in_progress",
      priority: "medium",
      assignees: [],
      activeTriggerCount: 1,
      hasContent: true,
      spec: "Raise branch coverage on every pure module in packages/lib to 100% without deleting tests.",
      loop: { iteration: 3, until: "coverage ratchet exits 0" },
    },
    {
      id: "t-sheetview",
      pageId: "pg-sheetview-epic",
      title: "SheetView — decomposition",
      status: "in_progress",
      priority: "medium",
      assignees: [],
      hasContent: true,
      spec: "Slice SheetView along render boundaries into pure components.",
      childLists: [sheetviewList],
    },
  ],
};

/** A second drive's board — worked by a session on a PageSpace-drive machine. */
export const cliDocsList: TaskList = {
  id: "tl-cli-docs",
  pageId: "pg-cli-docs",
  driveId: "drv-cli",
  title: "Docs",
  description: "pagespace-cli drive · its machine lives elsewhere — assignment is the only join.",
  statusConfigs: DEFAULT_STATUSES,
  tasks: [
    {
      id: "t-cli-keys",
      pageId: "pg-cli-keys",
      title: "Reference — pagespace keys + mcp pages",
      status: "in_progress",
      priority: "low",
      assignees: [{ kind: "session", id: "ag-cli-docs", label: "cli-reference-docs" }],
      hasContent: true,
      spec: "Given the CLI's keys/mcp subcommands, should document each with a runnable example.",
    },
  ],
};

export const boards: { driveName: string; list: TaskList }[] = [
  { driveName: "PageSpace", list: featuresList },
  { driveName: "pagespace-cli", list: cliDocsList },
];

/** Depth-first over a list's tasks and every nested list's tasks. */
export function flattenList(list: TaskList): TaskItem[] {
  return list.tasks.flatMap((t) => [t, ...(t.childLists ?? []).flatMap(flattenList)]);
}

export const allTasks = (): TaskItem[] => boards.flatMap(({ list }) => flattenList(list));

export const taskById = (id: string): TaskItem | undefined =>
  allTasks().find((t) => t.id === id);

/** The task a session is assigned to (the honest agent↔task edge). */
export const taskForSession = (sessionId: string): TaskItem | undefined =>
  allTasks().find((t) => t.assignees.some((a) => a.kind === "session" && a.id === sessionId));

export function statusGroupOf(slug: string, configs: TaskStatusConfig[]): TaskStatusGroup {
  return configs.find((c) => c.slug === slug)?.group ?? "todo";
}

/** Direct sub-task totals, aggregated across the task's nested lists — feeds the completion gate. */
export function subTaskCounts(task: TaskItem): { total: number; completed: number } {
  const lists = task.childLists ?? [];
  const total = lists.reduce((n, l) => n + l.tasks.length, 0);
  const completed = lists.reduce(
    (n, l) => n + l.tasks.filter((t) => statusGroupOf(t.status, l.statusConfigs) === "done").length,
    0,
  );
  return { total, completed };
}
