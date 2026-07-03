# Task Status Model

**Schema:** `packages/db/src/schema/tasks.ts`

There are **two distinct "status" concepts** in the task system. They are
easy to conflate because they're both called `status`, but only one of them
has a fixed value set.

**A note on "enum" here:** none of the `status`/`group` columns below are
backed by a native Postgres `ENUM` type or a `CHECK` constraint — the
generated migrations create them as plain `text` columns (e.g.
`packages/db/drizzle/0013_lethal_the_fallen.sql:9,26` for `task_lists.status`,
and the `task_status_configs` migration for `group`). Drizzle's
`text(col, { enum: [...] })` only gives you a typed value set in
**TypeScript/application code** — it is not enforced by the database itself.
Anything writing raw SQL (migrations, data-repair scripts, another service
hitting the DB directly) can insert values outside these sets; only
application-layer code paths validate them.

## 1. `taskLists.status` — a fixed value set (application-level, not DB-enforced)

The container (`task_lists` table) has its own status, independent of its
child tasks:

```ts
status: text('status', { enum: ['pending', 'in_progress', 'completed'] })
  .notNull()
  .default('pending')
```

Three values, no configurability, enforced by the TypeScript type — not by a
database constraint. It describes the task list as a whole, not any
individual task inside it.

## 2. `taskItems.status` — per-task-list configurable, not a global enum

`task_items.status` is a plain `text` column with **no enum constraint at the
schema level**:

```ts
status: text('status').notNull().default('pending')
```

Its valid values are defined per task list by the `taskStatusConfigs` table,
not globally. A task's `status` is really a foreign reference to that task
list's own `taskStatusConfigs.slug` — there is no `REFERENCES` constraint
enforcing this in the schema, so it's validated at the API layer instead (see
below).

### `taskStatusConfigs` — the real per-list status registry

```ts
export const taskStatusConfigs = pgTable('task_status_configs', {
  id: text('id').primaryKey(),
  taskListId: text('taskListId').notNull().references(() => taskLists.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  color: text('color').notNull(),
  group: text('group', { enum: ['todo', 'in_progress', 'done'] }).notNull(),
  position: integer('position').notNull().default(0),
  // ...
}, (table) => ({
  slugUnique: unique('task_status_configs_task_list_slug').on(table.taskListId, table.slug),
}));
```

- **`slug`** is the value stored on `taskItems.status`. Unique per task list
  (`(taskListId, slug)`), **not** unique globally — two different task lists
  can both have a status with slug `"pending"` that mean different things (or
  have entirely different custom slugs).
- **`group`** is the one fixed, global value set in the system:
  `'todo' | 'in_progress' | 'done'` — again enforced at the TypeScript layer
  by Drizzle's `{ enum }`, not by a database constraint (the generated
  migration creates `"group" text NOT NULL` with no `CHECK`). Every custom
  status — no matter what it's named or slugged — must map to one of these
  three groups. This is what lets the UI (kanban columns, progress bars) and
  any code that needs to reason about "is this task done" work generically
  across task lists with completely different status sets.

So: **the set of valid `status` slugs is per-task-list and user-configurable.
The set of valid `group` values is fixed globally at the application layer**
(not by the database). When in doubt about whether something is a hardcoded
value set, it's the `group`, not the `slug` — and even the `group` column
would accept an arbitrary string if written outside the application code
paths that validate it.

## Default statuses

`DEFAULT_TASK_STATUSES` (`packages/db/src/schema/tasks.ts`):

| slug | name | group |
|---|---|---|
| `pending` | To Do | `todo` |
| `in_progress` | In Progress | `in_progress` |
| `blocked` | Blocked | `in_progress` |
| `completed` | Done | `done` |

Note `blocked` maps to the `in_progress` group, not its own group — "blocked"
is UI/workflow nuance, not a distinct lifecycle stage as far as completion
tracking is concerned.

**This is not unconditionally seeded into `taskStatusConfigs` for every task
list.** Whether rows actually get written to the database depends on which
code path first creates the `task_lists` row:

- Paths that create the list via `getOrCreateTaskListForPage` /
  `addTaskItemUnderParent` (`apps/web/src/services/api/task-sync-service.ts`)
  — e.g. `POST /api/pages/[pageId]/tasks` — **do** insert
  `DEFAULT_TASK_STATUSES` as real `taskStatusConfigs` rows at creation time.
- Paths that auto-create a bare `task_lists` row on **read**
  (`POST /api/mcp/documents` with `operation: 'read'` on a `TASK_LIST` page,
  `route.ts` ~lines 187–199; and the equivalent in-app read tool in
  `apps/web/src/lib/ai/tools/page-read-tools.ts` ~lines 272–284) insert only
  the `task_lists` row — no `taskStatusConfigs` rows. These code paths
  compute `availableStatuses` by reading `taskStatusConfigs` and, if that
  query comes back empty, fall back to `DEFAULT_TASK_STATUSES` **in memory**
  for the response, without persisting anything.

Practically: a task list first materialized by a read can have zero
`taskStatusConfigs` rows in the database even though `read` responses look
identical either way (real rows or in-memory fallback). Don't write code or
migrations that assume every `task_lists` row has corresponding
`taskStatusConfigs` rows — query for them and use the same
`DEFAULT_TASK_STATUSES` fallback the read paths use.

## Customizing statuses

The slug set is **not** fixed at the codebase level — don't hardcode
assumptions about which slugs exist beyond the seeded defaults, and don't
validate a `status` string against a static list. Always resolve valid slugs
from that task list's current `taskStatusConfigs` rows. Two separate
surfaces manage this, and they are not symmetric:

- **Creating a new status:** the `create_task_status` tool
  (`apps/web/src/lib/ai/tools/task-management-tools.ts`), exposed both
  in-app and to external MCP clients — this is the only status-management
  tool an agent has. There is no `update_task_status` or
  `delete_task_status` tool.
- **Renaming, reordering, regrouping, or deleting statuses:** the REST route
  `PUT` / `DELETE /api/pages/[pageId]/tasks/statuses`
  (`apps/web/src/app/api/pages/[pageId]/tasks/statuses/route.ts`), used by
  the UI. `PUT` takes a bulk `{ statuses: [{ id, name, color, group, position }] }`
  array and updates all of them in one transaction; `DELETE` removes a status
  config and migrates any tasks on it to a replacement status. An AI agent
  that needs to rename or remove a status has no tool for that today — it
  would have to go through this REST endpoint directly, not an MCP tool.

## Where status is validated

### `POST /api/pages/[pageId]/tasks`

`apps/web/src/app/api/pages/[pageId]/tasks/route.ts` (~lines 408–420) validates
a provided `status` string against the task list's *current*
`taskStatusConfigs` slugs — computed dynamically per request, not hardcoded:

```ts
const validStatuses = await db.query.taskStatusConfigs.findMany({
  where: eq(taskStatusConfigs.taskListId, taskList.id),
  columns: { slug: true, group: true },
});
const validSlugs = validStatuses.map(s => s.slug);
if (validSlugs.length > 0 && !validSlugs.includes(status)) {
  return NextResponse.json(
    { error: `Invalid status "${status}". Valid statuses: ${validSlugs.join(', ')}` },
    { status: 400 }
  );
}
```

Error response example:

```json
{ "error": "Invalid status \"archived\". Valid statuses: pending, in_progress, blocked, completed" }
```

`400 Bad Request`.

Setting a status whose `group` is `'done'` (or, for a task list with no
custom configs yet, a literal `status === 'completed'`) stamps
`completedAt` on the task.

### `POST /api/mcp/documents` (`operation: 'read'`, `TASK_LIST` pages)

See [`mcp-documents-api.md`](./mcp-documents-api.md). The `read` operation
returns `availableStatuses` for a `TASK_LIST` page, computed the same way —
dynamically from that task list's `taskStatusConfigs`, falling back to
`DEFAULT_TASK_STATUSES` if none exist yet:

```jsonc
{
  "availableStatuses": [
    { "slug": "pending", "label": "To Do", "group": "todo", "position": 0, "color": "..." },
    { "slug": "in_progress", "label": "In Progress", "group": "in_progress", "position": 1, "color": "..." },
    { "slug": "blocked", "label": "Blocked", "group": "in_progress", "position": 2, "color": "..." },
    { "slug": "completed", "label": "Done", "group": "done", "position": 3, "color": "..." }
  ],
  "progress": {
    "total": 12,
    "percentage": 42,
    "byGroup": { "todo": 4, "in_progress": 3, "done": 5 },
    "bySlug": { "pending": 4, "in_progress": 2, "blocked": 1, "completed": 5 }
  }
}
```

`progress.byGroup` is always keyed by the fixed three-value group enum;
`progress.bySlug` reflects whatever custom slugs that specific task list uses.
