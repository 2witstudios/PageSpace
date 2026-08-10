/**
 * The mock data model. Every shape here mirrors the future cloud-agent API
 * (see DESIGN.md §9) so swapping fixtures for fetches is mechanical.
 */

export type AgentStatus = "running" | "waiting" | "broken" | "benched";
export type AgentRuntime = "claude" | "codex" | "terminal";

/** A repo + branch pair on a workspace — the cloud analog of a worktree. */
export interface Checkout {
  workspaceId: string;
  repo: string;
  branch: string;
}

export interface DiffStat {
  additions: number;
  deletions: number;
  files: number;
}

export interface TranscriptLine {
  /** Who produced the line — drives the mono color treatment. */
  kind: "command" | "output" | "agent" | "system";
  text: string;
}

export interface Agent {
  id: string;
  name: string;
  runtime: AgentRuntime;
  status: AgentStatus;
  /** Root agent that orchestrates rather than codes. At most one in the mock. */
  isPointGuard?: boolean;
  /** The task this agent is grounded on — its prompt IS that task's spec. */
  taskId?: string;
  /** null = root agent (no checkout of its own). */
  checkout: Checkout | null;
  /** Human-readable ages, precomputed — mock data has no clock. */
  spawnedAgo: string;
  lastActivityAgo: string;
  diff: DiffStat | null;
  /** The `pu logs` tail shown on fleet cards. */
  logTail: string[];
  /** Fuller scrollback for the terminal pane mock. */
  transcript: TranscriptLine[];
  /** Exit code, only for broken agents. */
  exitCode?: number;
}

export type WorkspaceStatus = "ready" | "booting" | "stopped";

export interface WorkspaceBranch {
  name: string;
  agentIds: string[];
}

export interface WorkspaceRepo {
  name: string;
  defaultBranch: string;
  branches: WorkspaceBranch[];
}

export interface Workspace {
  id: string;
  name: string;
  /**
   * The drive whose page tree holds this machine's MACHINE page. Machines
   * live in drives like any page — but this is a WHERE-IT-LIVES fact, not a
   * scope: a session on this machine can work a task from ANY drive
   * (DESIGN.md §2.7 — the two hierarchies join only through assignment).
   */
  driveId: string;
  driveName: string;
  region: string;
  size: string;
  status: WorkspaceStatus;
  repos: WorkspaceRepo[];
  usage: {
    cpuPct: number;
    memGb: number;
    memUsedGb: number;
    diskGb: number;
    diskUsedGb: number;
  };
}

export type DiffScope = "uncommitted" | "committed" | "branch";

export interface DiffLine {
  kind: "context" | "add" | "del" | "hunk";
  text: string;
}

export interface DiffFile {
  path: string;
  additions: number;
  deletions: number;
  lines: DiffLine[];
}

/** Per-agent, per-scope changed files. Missing scope = clean. */
export type AgentDiff = Partial<Record<DiffScope, DiffFile[]>>;

/**
 * Task shapes mirror the REAL PageSpace model (packages/db/src/schema/tasks.ts
 * + apps/web task-list views), not an invented one:
 *
 * - A task list is a TASK_LIST page in a drive; tasks are `task_items`, each
 *   backed by a DOCUMENT page that owns the title and body (the spec).
 * - Nesting is the PAGE TREE: a task's page contains child TASK_LIST pages.
 *   There is no `children` array on a task — `childLists` here stands in for
 *   "the nested TASK_LIST pages inside this task's page".
 * - Statuses are per-list configs (slug/name/color/group/position); kanban
 *   columns are the status order. Groups map to system behavior.
 * - Completion of a parent with open sub-tasks is BLOCKED ("Finish N
 *   sub-tasks first") — that is the real gate, not a bespoke gate object.
 * - Assignees are users AND agents (taskAssignees); a cloud session working a
 *   task is modeled as an assignee of kind "session".
 */
export type TaskStatusGroup = "todo" | "in_progress" | "done";

export interface TaskStatusConfig {
  slug: string;
  name: string;
  /** Tailwind class string, exactly as the real configs store it. */
  color: string;
  group: TaskStatusGroup;
  position: number;
}

export type TaskPriority = "low" | "medium" | "high";

export interface TaskAssignee {
  kind: "user" | "agent-page" | "session";
  id: string;
  label: string;
}

export interface TaskLoop {
  /** Completed iterations so far (mock for metadata.loop + a ralph-loop workflow). */
  iteration: number;
  /** The acceptance condition the loop runs until. */
  until: string;
}

export interface TaskItem {
  id: string;
  /** The linked DOCUMENT page that owns the title and body. */
  pageId: string;
  title: string;
  /** A status SLUG from the owning list's statusConfigs. */
  status: string;
  priority: TaskPriority;
  dueDate?: string;
  assignees: TaskAssignee[];
  /** Live trigger count, as the real /tasks payload serves it. */
  activeTriggerCount?: number;
  /** The linked page has body content beyond nested lists. */
  hasContent: boolean;
  /** The linked page's body — "Given X, should Y" — the agent's prompt. */
  spec?: string;
  /** Nested TASK_LIST pages inside this task's page. */
  childLists?: TaskList[];
  loop?: TaskLoop;
}

export interface TaskList {
  id: string;
  pageId: string;
  driveId: string;
  title: string;
  description?: string;
  statusConfigs: TaskStatusConfig[];
  tasks: TaskItem[];
}

export type TriggerEvent = "agent_idle" | "pre_commit" | "pre_push" | "task_status";

export interface TriggerStep {
  inject?: string;
  gate?: { run: string; expectExit: number };
  maxRetries?: number;
}

export interface Trigger {
  name: string;
  description: string;
  event: TriggerEvent;
  enabled: boolean;
  steps: TriggerStep[];
}

export type Recurrence =
  | "none"
  | "hourly"
  | "daily"
  | "weekdays"
  | "weekly"
  | "monthly";

export interface Schedule {
  name: string;
  nextRun: string;
  recurrence: Recurrence;
  mode: "checkout" | "root";
  triggerType: "inline-prompt" | "agent-def" | "swarm-def";
  triggerRef: string;
  enabled: boolean;
}

/**
 * A PageSpace command: a parameterized, reusable prompt. This is what
 * PurePoint called a "template" — the platform already has the primitive, so
 * PageSpace Dev reads drive commands instead of keeping its own library.
 */
export interface Command {
  /** Slash-style name, e.g. "/code-review". */
  name: string;
  description: string;
  runtime?: AgentRuntime;
  variables: string[];
  body: string;
}
