/**
 * `pagespace tasks list|create|update|delete|reorder|statuses|create-status|assigned`
 * (Phase 5 task 3). Thin projections over the `tasks.*` SDK operations —
 * every underlying operation (`create`, `update`, `delete`, `reorder`,
 * `createStatus`, `getAssigned`) was already defined and wired on the client
 * facade by Phase 3 task 4, so this module adds no SDK surface, only argv
 * parsing and result rendering.
 *
 * `list`/`statuses` have no dedicated SDK operation of their own — both are
 * thin views over `pages.read`'s TASK_LIST branch (already wired by Phase 3
 * task 2), which is the exact payload `read_page` on a TASK_LIST page
 * returns: tasks, availableStatuses, and progress in one call. `--json`
 * always emits that whole raw response for either verb (same rule the
 * merged `pages`/`trash` verbs follow: `--json` is never a filtered subset
 * of what human mode chooses to render).
 *
 * `update`'s container-gating rejection (server blocks completing a parent
 * with open sub-tasks) needs no special handling here: `callSdk` already
 * writes the caught error's `.message` to stderr unmodified, which *is*
 * "render that message faithfully" — the server's own text already embeds
 * the pending/total counts. `classifyTaskCompletionGate` (SDK) exists for
 * callers that need to branch on the gate programmatically; this command
 * doesn't need to.
 */
import type { PageSpaceClient } from '@pagespace/sdk';
import { priorityEnum, statusGroupEnum } from '@pagespace/sdk';
import { confirmationFailureMessage, confirmDestructive } from '../confirm.js';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from '../exit-codes.js';
import type { CommandHandler } from '../router/router.js';
import { callSdk } from './sdk-error.js';

type PagesReadResult = Awaited<ReturnType<PageSpaceClient['pages']['read']>>;
type TaskListRead = Extract<PagesReadResult, { pageType: 'TASK_LIST' }>;

/** Pure: no I/O. */
export function renderTasksList(value: TaskListRead): string {
  const lines = value.tasks.map((task) => `[${task.status}] ${task.id}  ${task.title}  (priority: ${task.priority})`);
  lines.push(`Progress: ${value.progress.percentage}% (${value.progress.total} tasks)`);
  return `${lines.join('\n')}\n`;
}

/** Pure: no I/O. */
export function renderTaskStatuses(value: TaskListRead): string {
  if (value.availableStatuses.length === 0) {
    return 'No statuses.\n';
  }
  return `${value.availableStatuses.map((status) => `${status.slug}  ${status.label}  [${status.group}]`).join('\n')}\n`;
}

export const tasksListHandler: CommandHandler = async (ctx, intent) => {
  const [pageId] = intent.args;
  if (!pageId || intent.args.length > 1) {
    ctx.stderr.write('Usage: pagespace tasks list <taskListPageId>\n');
    return EXIT_USAGE_ERROR;
  }

  const result = await callSdk(ctx.stderr, () => ctx.sdk.pages.read({ operation: 'read', pageId }));
  if (!result.ok) return EXIT_RUNTIME_ERROR;

  if (intent.flags.json) {
    ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
    return EXIT_SUCCESS;
  }

  if (result.value.pageType !== 'TASK_LIST') {
    ctx.stderr.write(`Page ${pageId} is not a task list.\n`);
    return EXIT_RUNTIME_ERROR;
  }

  ctx.stdout.write(renderTasksList(result.value));
  return EXIT_SUCCESS;
};

export const tasksStatusesHandler: CommandHandler = async (ctx, intent) => {
  const [pageId] = intent.args;
  if (!pageId || intent.args.length > 1) {
    ctx.stderr.write('Usage: pagespace tasks statuses <taskListPageId>\n');
    return EXIT_USAGE_ERROR;
  }

  const result = await callSdk(ctx.stderr, () => ctx.sdk.pages.read({ operation: 'read', pageId }));
  if (!result.ok) return EXIT_RUNTIME_ERROR;

  if (intent.flags.json) {
    ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
    return EXIT_SUCCESS;
  }

  if (result.value.pageType !== 'TASK_LIST') {
    ctx.stderr.write(`Page ${pageId} is not a task list.\n`);
    return EXIT_RUNTIME_ERROR;
  }

  ctx.stdout.write(renderTaskStatuses(result.value));
  return EXIT_SUCCESS;
};

type FlagScanResult =
  | { readonly ok: true; readonly values: ReadonlyMap<string, string>; readonly rest: readonly string[] }
  | { readonly ok: false; readonly message: string };

/** Pure: no I/O. Consumes any of `flags`' value-taking tokens, passing everything else through in `rest`. */
function scanValueFlags(args: readonly string[], flags: readonly string[]): FlagScanResult {
  const values = new Map<string, string>();
  const rest: string[] = [];
  let i = 0;
  while (i < args.length) {
    const token = args[i] as string;
    if (flags.includes(token)) {
      const value = args[i + 1];
      if (value === undefined) return { ok: false, message: `Flag ${token} requires a value.` };
      values.set(token, value);
      i += 2;
      continue;
    }
    rest.push(token);
    i += 1;
  }
  return { ok: true, values, rest };
}

export interface TaskCreateFlags {
  readonly title: string | undefined;
  readonly status: string | undefined;
  readonly priority: string | undefined;
  readonly due: string | undefined;
  readonly assignee: string | undefined;
  readonly rest: readonly string[];
}
export type ExtractTaskCreateFlagsResult = ({ readonly ok: true } & TaskCreateFlags) | { readonly ok: false; readonly message: string };

/** Pure: no I/O. */
export function extractTaskCreateFlags(args: readonly string[]): ExtractTaskCreateFlagsResult {
  const scanned = scanValueFlags(args, ['--title', '--status', '--priority', '--due', '--assignee']);
  if (!scanned.ok) return scanned;
  return {
    ok: true,
    title: scanned.values.get('--title'),
    status: scanned.values.get('--status'),
    priority: scanned.values.get('--priority'),
    due: scanned.values.get('--due'),
    assignee: scanned.values.get('--assignee'),
    rest: scanned.rest,
  };
}

export interface TaskUpdateFlags {
  readonly title: string | undefined;
  readonly status: string | undefined;
  readonly priority: string | undefined;
  readonly due: string | undefined;
  readonly rest: readonly string[];
}
export type ExtractTaskUpdateFlagsResult = ({ readonly ok: true } & TaskUpdateFlags) | { readonly ok: false; readonly message: string };

/** Pure: no I/O. Deliberately excludes `--assignee` — this task's spec scopes `update` to status/title/priority/due. */
export function extractTaskUpdateFlags(args: readonly string[]): ExtractTaskUpdateFlagsResult {
  const scanned = scanValueFlags(args, ['--title', '--status', '--priority', '--due']);
  if (!scanned.ok) return scanned;
  return {
    ok: true,
    title: scanned.values.get('--title'),
    status: scanned.values.get('--status'),
    priority: scanned.values.get('--priority'),
    due: scanned.values.get('--due'),
    rest: scanned.rest,
  };
}

export interface TaskStatusCreateFlags {
  readonly name: string | undefined;
  readonly color: string | undefined;
  readonly group: string | undefined;
  readonly position: string | undefined;
  readonly rest: readonly string[];
}
export type ExtractTaskStatusCreateFlagsResult =
  | ({ readonly ok: true } & TaskStatusCreateFlags)
  | { readonly ok: false; readonly message: string };

/** Pure: no I/O. */
export function extractTaskStatusCreateFlags(args: readonly string[]): ExtractTaskStatusCreateFlagsResult {
  const scanned = scanValueFlags(args, ['--name', '--color', '--group', '--position']);
  if (!scanned.ok) return scanned;
  return {
    ok: true,
    name: scanned.values.get('--name'),
    color: scanned.values.get('--color'),
    group: scanned.values.get('--group'),
    position: scanned.values.get('--position'),
    rest: scanned.rest,
  };
}

export const tasksCreateHandler: CommandHandler = async (ctx, intent) => {
  const [pageId, ...rest0] = intent.args;
  const usage =
    'Usage: pagespace tasks create <pageId> --title <title> [--priority low|medium|high] [--status <slug>] [--due <date>] [--assignee <userId>]\n';
  if (!pageId) {
    ctx.stderr.write(usage);
    return EXIT_USAGE_ERROR;
  }

  const parsed = extractTaskCreateFlags(rest0);
  if (!parsed.ok) {
    ctx.stderr.write(`${parsed.message}\n`);
    return EXIT_USAGE_ERROR;
  }
  if (parsed.rest.length > 0) {
    ctx.stderr.write(`Unknown argument: ${parsed.rest[0]}\n`);
    return EXIT_USAGE_ERROR;
  }
  if (!parsed.title) {
    ctx.stderr.write('Flag --title is required.\n');
    return EXIT_USAGE_ERROR;
  }
  if (parsed.priority !== undefined && !priorityEnum.safeParse(parsed.priority).success) {
    ctx.stderr.write(`Invalid --priority "${parsed.priority}". Expected one of: ${priorityEnum.options.join(', ')}\n`);
    return EXIT_USAGE_ERROR;
  }

  const result = await callSdk(ctx.stderr, () =>
    ctx.sdk.tasks.create({
      pageId,
      title: parsed.title as string,
      priority: parsed.priority as 'low' | 'medium' | 'high' | undefined,
      status: parsed.status,
      dueDate: parsed.due,
      assigneeId: parsed.assignee,
    }),
  );
  if (!result.ok) return EXIT_RUNTIME_ERROR;

  if (intent.flags.json) {
    ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
  } else {
    ctx.stdout.write(`Created task ${result.value.id}  ${result.value.title}  [${result.value.status}]\n`);
  }
  return EXIT_SUCCESS;
};

export const tasksUpdateHandler: CommandHandler = async (ctx, intent) => {
  const [pageId, taskId, ...rest0] = intent.args;
  const usage = 'Usage: pagespace tasks update <pageId> <taskId> [--status <slug>] [--title <title>] [--priority low|medium|high] [--due <date>]\n';
  if (!pageId || !taskId) {
    ctx.stderr.write(usage);
    return EXIT_USAGE_ERROR;
  }

  const parsed = extractTaskUpdateFlags(rest0);
  if (!parsed.ok) {
    ctx.stderr.write(`${parsed.message}\n`);
    return EXIT_USAGE_ERROR;
  }
  if (parsed.rest.length > 0) {
    ctx.stderr.write(`Unknown argument: ${parsed.rest[0]}\n`);
    return EXIT_USAGE_ERROR;
  }
  if (parsed.priority !== undefined && !priorityEnum.safeParse(parsed.priority).success) {
    ctx.stderr.write(`Invalid --priority "${parsed.priority}". Expected one of: ${priorityEnum.options.join(', ')}\n`);
    return EXIT_USAGE_ERROR;
  }

  const result = await callSdk(ctx.stderr, () =>
    ctx.sdk.tasks.update({
      pageId,
      taskId,
      title: parsed.title,
      status: parsed.status,
      priority: parsed.priority as 'low' | 'medium' | 'high' | undefined,
      dueDate: parsed.due,
    }),
  );
  if (!result.ok) return EXIT_RUNTIME_ERROR;

  if (intent.flags.json) {
    ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
  } else {
    ctx.stdout.write(`Updated task ${result.value.id}  ${result.value.title}  [${result.value.status}]\n`);
  }
  return EXIT_SUCCESS;
};

export const tasksDeleteHandler: CommandHandler = async (ctx, intent) => {
  const [pageId, taskId] = intent.args;
  if (!pageId || !taskId) {
    ctx.stderr.write('Usage: pagespace tasks delete <pageId> <taskId> [--yes]\n');
    return EXIT_USAGE_ERROR;
  }

  const confirmation = await confirmDestructive(`Delete task ${taskId}? [y/N] `, {
    isTTY: ctx.isTTY,
    yes: intent.flags.yes,
    prompt: ctx.prompt,
  });
  if (!confirmation.ok) {
    ctx.stderr.write(`${confirmationFailureMessage(confirmation)}\n`);
    return EXIT_RUNTIME_ERROR;
  }

  const result = await callSdk(ctx.stderr, () => ctx.sdk.tasks.delete({ pageId, taskId }));
  if (!result.ok) return EXIT_RUNTIME_ERROR;

  if (intent.flags.json) {
    ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
  } else {
    ctx.stdout.write(`Deleted task ${taskId}.\n`);
  }
  return EXIT_SUCCESS;
};

export const tasksReorderHandler: CommandHandler = async (ctx, intent) => {
  const [pageId, taskId, rawPosition] = intent.args;
  if (!pageId || !taskId || rawPosition === undefined || intent.args.length > 3) {
    ctx.stderr.write('Usage: pagespace tasks reorder <pageId> <taskId> <position>\n');
    return EXIT_USAGE_ERROR;
  }

  const position = Number(rawPosition);
  if (!Number.isFinite(position)) {
    ctx.stderr.write(`Invalid position "${rawPosition}": must be a finite number.\n`);
    return EXIT_USAGE_ERROR;
  }

  const result = await callSdk(ctx.stderr, () => ctx.sdk.tasks.reorder({ pageId, taskId, position }));
  if (!result.ok) return EXIT_RUNTIME_ERROR;

  if (intent.flags.json) {
    ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
  } else {
    ctx.stdout.write(`Reordered task ${result.value.id} to position ${result.value.position}.\n`);
  }
  return EXIT_SUCCESS;
};

export const tasksCreateStatusHandler: CommandHandler = async (ctx, intent) => {
  const [pageId, ...rest0] = intent.args;
  const usage = 'Usage: pagespace tasks create-status <pageId> --name <name> --color <color> --group todo|in_progress|done [--position N]\n';
  if (!pageId) {
    ctx.stderr.write(usage);
    return EXIT_USAGE_ERROR;
  }

  const parsed = extractTaskStatusCreateFlags(rest0);
  if (!parsed.ok) {
    ctx.stderr.write(`${parsed.message}\n`);
    return EXIT_USAGE_ERROR;
  }
  if (parsed.rest.length > 0) {
    ctx.stderr.write(`Unknown argument: ${parsed.rest[0]}\n`);
    return EXIT_USAGE_ERROR;
  }
  if (!parsed.name || !parsed.color || !parsed.group) {
    ctx.stderr.write(usage);
    return EXIT_USAGE_ERROR;
  }
  if (!statusGroupEnum.safeParse(parsed.group).success) {
    ctx.stderr.write(`Invalid --group "${parsed.group}". Expected one of: ${statusGroupEnum.options.join(', ')}\n`);
    return EXIT_USAGE_ERROR;
  }

  let position: number | undefined;
  if (parsed.position !== undefined) {
    position = Number(parsed.position);
    if (!Number.isFinite(position)) {
      ctx.stderr.write(`Invalid --position "${parsed.position}": must be a finite number.\n`);
      return EXIT_USAGE_ERROR;
    }
  }

  const result = await callSdk(ctx.stderr, () =>
    ctx.sdk.tasks.createStatus({
      pageId,
      name: parsed.name as string,
      color: parsed.color as string,
      group: parsed.group as 'todo' | 'in_progress' | 'done',
      position,
    }),
  );
  if (!result.ok) return EXIT_RUNTIME_ERROR;

  if (intent.flags.json) {
    ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
  } else {
    ctx.stdout.write(`Created status ${result.value.slug}  ${result.value.name}  [${result.value.group}]\n`);
  }
  return EXIT_SUCCESS;
};

export const tasksAssignedHandler: CommandHandler = async (ctx, intent) => {
  if (intent.args.length > 0) {
    ctx.stderr.write('Usage: pagespace tasks assigned [--json]\n');
    return EXIT_USAGE_ERROR;
  }

  const result = await callSdk(ctx.stderr, () => ctx.sdk.tasks.getAssigned({}));
  if (!result.ok) return EXIT_RUNTIME_ERROR;

  if (intent.flags.json) {
    ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
    return EXIT_SUCCESS;
  }

  if (result.value.tasks.length === 0) {
    ctx.stdout.write('No assigned tasks.\n');
    return EXIT_SUCCESS;
  }
  ctx.stdout.write(
    `${result.value.tasks.map((task) => `[${task.statusLabel}] ${task.id}  ${task.title}  (priority: ${task.priority})`).join('\n')}\n`,
  );
  return EXIT_SUCCESS;
};
