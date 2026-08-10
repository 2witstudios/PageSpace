/**
 * THE PRE-`0256` SHAPE OF THE TABLES THE NODE BACKFILL READS.
 *
 * `scripts/backfill-agent-workspace-nodes.ts` runs in a window that no longer
 * exists in the application's schema: **after** migration `0255` creates
 * `agent_workspace_nodes`, and **before** migration `0256` drops the four
 * layout tables and the two `conversations` membership columns. It is the one
 * piece of code whose subject is a database state the app is not allowed to
 * have, so it needs a description of that state, and this is it.
 *
 * **Why it is not `@pagespace/db/schema`.** It used to be. `0256`'s companion
 * refactor deleted `packages/db/src/schema/agent-workspace-layout.ts` and the
 * `workspaceId` / `closedInWorkspaceAt` columns from
 * `packages/db/src/schema/conversations.ts` — correctly, because after cutover
 * the app must not be able to name them. The backfill's imports went with them
 * and the script stopped resolving at all; nothing noticed, because `scripts/`
 * is inside no tsconfig and no test suite ran it. Pointing the migration at the
 * live schema was the mistake: a migration's subject is the schema it is
 * migrating FROM, which by definition stops existing the moment it succeeds.
 *
 * **Read-only, and only the columns the derivation consumes.** No `relations`,
 * no foreign keys and no `createdAt`/`updatedAt` on the layout tables — nothing
 * here is ever inserted into or updated, and a partial declaration that cannot
 * express a write is the honest shape for a read. Drizzle emits the table names
 * verbatim, so these resolve against the real pre-`0256` tables.
 *
 * **DELETE THIS FILE WHEN THE BACKFILL IS DELETED.** Both exist for the one
 * window between `0255` and `0256`; once every database has been through it,
 * the script, this file and
 * `@pagespace/lib/agent-workspaces/workspace-node-backfill` all go together.
 */

import { pgTable, text, integer, real, timestamp, boolean } from 'drizzle-orm/pg-core';

/** `agent_workspace_pane_columns` — the grid's columns. Dropped by `0256`. */
export const legacyPaneColumns = pgTable('agent_workspace_pane_columns', {
  /** Client-minted, unique per workspace only (the live table's PK is compound). */
  id: text('id').notNull(),
  workspaceId: text('workspaceId').notNull(),
  /** Meant to be contiguous and 0-based; the derivation re-derives order from the sort. */
  orderIndex: integer('orderIndex').notNull(),
  widthFraction: real('widthFraction'),
});

/** `agent_workspace_panes` — the panes inside those columns. Dropped by `0256`. */
export const legacyPanes = pgTable('agent_workspace_panes', {
  id: text('id').notNull(),
  workspaceId: text('workspaceId').notNull(),
  columnId: text('columnId').notNull(),
  orderIndex: integer('orderIndex').notNull(),
  /**
   * `'chat' | 'terminal' | 'page'`, or NULL for an unbound picker pane —
   * declared as plain `text` because that is what it is: the column has no
   * check constraint behind it, so what a reader gets is whatever a writer put
   * there. `LegacyPane.kind` is typed `string | null` for the same reason.
   */
  kind: text('kind'),
  /** conversationId | shellId | pageId by `kind` — polymorphic, deliberately no FK. */
  targetId: text('targetId'),
  heightFraction: real('heightFraction'),
});

/**
 * `conversations`, as it stands BEFORE `0256` drops its two membership columns.
 *
 * Declared separately rather than by extending the live `conversations` table
 * so that the two can never appear in one query: they name the same physical
 * table, and Drizzle would emit it twice and produce the ambiguous-column
 * failure that took `listSessionConversationsBulk` down earlier in this epic.
 * The backfill uses THIS one exclusively.
 */
export const legacyConversations = pgTable('conversations', {
  id: text('id').notNull(),
  /**
   * The workspace that holds this thread, or NULL for one that is not in a
   * workspace at all. Half of the old membership; superseded by a chat-bound
   * node. Dropped by `0256`.
   */
  workspaceId: text('workspaceId'),
  /**
   * When the user closed this thread OUT of its workspace's listing — the other
   * half. **The single most load-bearing column in this migration**: a thread
   * with this stamped is not a member, its pane row was never removed by
   * anything on the server, and materialising that pane would put every thread
   * every user ever dismissed back on their grid. Dropped by `0256`.
   */
  closedInWorkspaceAt: timestamp('closedInWorkspaceAt', { mode: 'date' }),
  /** `false` once the thread is history-deleted. Survives `0256`. */
  isActive: boolean('isActive').notNull(),
  createdAt: timestamp('createdAt', { mode: 'date' }).notNull(),
});
