/**
 * WHAT IS LEFT IN THIS MODULE IS THE OLD LAYOUT MODEL'S WIRE SHAPE, AND IT IS
 * SCHEDULED FOR DELETION WITH THAT MODEL. Do not add to it, and prefer not to
 * import from it in new code.
 *
 * This file used to be "the ONE agent-workspace contract" and held three
 * unrelated concerns at once, which is why deleting the old layout model looked
 * like a 26-file change when only a handful of files actually touch layout
 * (`.pu-reports/audit-simplicity.md`, Pass 5). The two concerns that were never
 * layout, and that outlive the old model, have moved out:
 *
 * - shells and the shell bridge → `./shells-contract`
 * - session identity + sandbox lifecycle → `./session-contract`
 *
 * The two semantic invariants that govern the agent-workspace surface — a
 * session OWNS conversations, and ids address while names label — are written
 * down in `./session-contract`.
 *
 * What remains here is exactly the pane-grid layout model's wire shape: what a
 * pane displays (`PANE_KINDS`), what it is bound to (`paneScopeSchema`), and the
 * server-persisted grid of columns and panes (`persistedWorkspaceStateSchema`).
 * The workspace node model replaces all of it. When `workspace-layout-verbs.ts`
 * and the `agent_workspace_panes` / `agent_workspace_pane_columns` tables go,
 * this module goes with them.
 */

import { z } from 'zod';

/**
 * What a pane displays. The discriminator lives on the PANE BINDING rather than
 * on either row type, because the two surfaces are now two different tables and
 * a pane is the one place that has to talk about both.
 *
 * `'chat'` addresses a conversation (one thread among the session's many —
 * invariant 1); `'terminal'` addresses a `shellId`; `'page'` addresses a
 * PageSpace pageId — any non-container, non-chat page type (a document, task
 * list, sheet, canvas, code file, ...), rendered read/write via the same
 * page-type dispatch the main content area uses. Unlike `'chat'`/`'terminal'`,
 * a `'page'` binding mints no row anywhere: the target already exists as a
 * page, so binding it is a pure client-side assignment.
 */
export const PANE_KINDS = ['chat', 'terminal', 'page'] as const;

export const paneKindSchema = z.enum(PANE_KINDS);
export type PaneKind = z.infer<typeof paneKindSchema>;

/**
 * A pane's binding: what it shows, and the id it shows it for. `null` id is a
 * bound-but-not-yet-resolved pane (the picker just chose a kind); an unbound
 * pane stores no scope at all and renders the picker.
 */
export const paneScopeSchema = z.object({
  kind: paneKindSchema,
  /** Display label — the conversation title or the shell name. Never an address. */
  name: z.string(),
  /** The conversationId (chat), shellId (terminal), or pageId (page) this pane is bound to. */
  targetId: z.string().min(1).nullable(),
  /**
   * Which agent the conversation belongs to, for a `'chat'` pane. Null for a
   * global-assistant conversation, and irrelevant for a terminal — so a single
   * grid can hold conversations with several different agents side by side.
   */
  agentPageId: z.string().min(1).nullable(),
});

export type PaneScope = z.infer<typeof paneScopeSchema>;

/**
 * A session's server-persisted pane grid — columns and each pane's binding.
 * This is the ONE declaration both the DB column's `$type`
 * (`packages/db/schema/agent-workspaces.ts`'s `PersistedWorkspaceState`, a
 * structural mirror only — `packages/db` cannot import `@pagespace/lib`) and
 * every API route's body validator use; parse with this, never trust an `as`
 * cast.
 *
 * A pane holds exactly ONE `scope` — pane tabs (a pane holding several open
 * conversations, switchable via a strip) were tried and removed; the UX
 * wasn't understood well enough against the app's other tab systems. `tabs`
 * is still accepted on input so a grid saved before the removal (server row
 * or localStorage) keeps parsing instead of failing validation wholesale, but
 * it is never required and never appears in the parsed output — every reader
 * downstream sees only `{ id, scope }`.
 */
export const persistedPaneStateSchema = z
  .object({
    id: z.string().min(1),
    scope: paneScopeSchema.nullable(),
    tabs: z.array(paneScopeSchema).optional(),
    /**
     * This pane's share of its column's height (issue #2208). Optional and
     * nullable on the WIRE — an unsized column carries no fractions at all,
     * and every grid written before the resize verbs shipped is exactly that
     * — but never partially trusted: the reducer reads a container whose
     * members are not ALL sized as unsized, and re-establishes the invariant
     * itself. Preserved through the transform (unlike `tabs`) because it IS a
     * live field, not a retired one.
     */
    heightFraction: z.number().nullable().optional(),
  })
  .transform(({ id, scope, heightFraction }) => ({
    id,
    scope,
    ...(typeof heightFraction === 'number' ? { heightFraction } : {}),
  }));
export type PersistedPaneState = z.infer<typeof persistedPaneStateSchema>;

export const persistedColumnStateSchema = z
  .object({
    id: z.string().min(1),
    panes: z.array(persistedPaneStateSchema).min(1),
    /** This column's share of the grid's width — {@link persistedPaneStateSchema}'s twin. */
    widthFraction: z.number().nullable().optional(),
  })
  .transform(({ id, panes, widthFraction }) => ({
    id,
    panes,
    ...(typeof widthFraction === 'number' ? { widthFraction } : {}),
  }));
export type PersistedColumnState = z.infer<typeof persistedColumnStateSchema>;

export const persistedWorkspaceStateSchema = z.object({
  id: z.string().min(1),
  columns: z.array(persistedColumnStateSchema).min(1),
  activePaneId: z.string().min(1),
  pendingPickerPaneId: z.string().min(1).nullable(),
});
export type PersistedWorkspaceState = z.infer<typeof persistedWorkspaceStateSchema>;
