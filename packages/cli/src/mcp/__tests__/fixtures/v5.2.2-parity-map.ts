/**
 * Parity map: v5.2.2 `pagespace-mcp` tool name -> current SDK operation name
 * (Phase 6 task 2). This is the one place a rename/reshape/drop is allowed
 * to exist without failing the parity test in `../v5.2.2-parity.test.ts` —
 * every entry here must cite a reason (a `docs/sdk/operations-inventory.md`
 * `D#` row where one exists), never a silent skip.
 *
 * Every one of the 67 tools in `fixtures/v5.2.2-tools.json` must appear in
 * EXACTLY one of `TOOL_NAME_ALIASES` or `DROPPED_TOOLS` — the test asserts
 * this partition is total and disjoint, so an unmapped tool fails loudly
 * naming itself, not silently passing or silently skipping.
 */

/** How a single v5.2.2-required field maps onto the new operation's input schema. */
export type FieldMapping =
  /** Field name is unchanged. */
  | { readonly kind: 'same' }
  /** Field was renamed; `to` is the new property name. */
  | { readonly kind: 'renamed'; readonly to: string; readonly reason: string }
  /** Field no longer exists anywhere and needs none — verified decorative/never read server-side. */
  | { readonly kind: 'dropped'; readonly reason: string }
  /** Field's old flat value is now supplied inside a differently-shaped new field named `into`. */
  | { readonly kind: 'reshaped'; readonly into: string; readonly reason: string };

export interface ToolMapping {
  /** The current SDK operation name (`Operation.name`, dotted namespace) this old tool maps to. */
  readonly opName: string;
  /**
   * Per-required-field overrides, keyed by the OLD tool's field name. Any
   * v5.2.2-required field not listed here defaults to `SAME` (name
   * unchanged). Only list fields that actually need a non-`same` mapping.
   */
  readonly fields?: Readonly<Record<string, FieldMapping>>;
}

/**
 * The 66 v5.2.2 tools that map onto a live operation in the current SDK
 * registry (`packages/sdk/src/operations/*.ts`, assembled by
 * `buildOperationRegistry` in `../../serve.ts`).
 */
export const TOOL_NAME_ALIASES: Readonly<Record<string, ToolMapping>> = {
  // ── Drives ──────────────────────────────────────────────────────────────
  list_drives: { opName: 'drives.list' },
  create_drive: { opName: 'drives.create' },
  rename_drive: { opName: 'drives.rename' },
  update_drive_context: { opName: 'drives.updateContext' },
  trash_drive: { opName: 'drives.trash' },
  restore_drive: { opName: 'drives.restore' },

  // ── Page listing & trash listing ────────────────────────────────────────
  // `driveSlug` was tool-layer-only decoration — the route never read it
  // (pages.ts `listPages`/`listTrash` doc comments; operations-inventory.md
  // §2.2 "driveSlug is a tool-layer nicety the route never reads").
  list_pages: {
    opName: 'pages.list',
    fields: { driveSlug: { kind: 'dropped', reason: 'decorative only — route never reads driveSlug (inventory §2.2)' } },
  },
  list_trash: {
    opName: 'pages.listTrash',
    fields: { driveSlug: { kind: 'dropped', reason: 'decorative only — route never reads driveSlug (inventory §2.2)' } },
  },

  // ── Page read & metadata ────────────────────────────────────────────────
  read_page: { opName: 'pages.read' },
  get_page_details: { opName: 'pages.details' },

  // ── Page write ───────────────────────────────────────────────────────────
  create_page: { opName: 'pages.create' },
  rename_page: { opName: 'pages.rename' },
  // D-note (pages.ts `movePage` doc): wire body is `{pageId, newParentId,
  // newPosition}` — `position` renamed to match the route's own field name.
  move_page: {
    opName: 'pages.move',
    fields: { position: { kind: 'renamed', to: 'newPosition', reason: 'wire body field is newPosition, matching pages/reorder route exactly' } },
  },
  replace_lines: { opName: 'pages.replaceLines' },
  trash_page: { opName: 'pages.trash' },
  restore_page: { opName: 'pages.restore' },
  edit_sheet_cells: { opName: 'pages.editCells' },

  // ── Task management ──────────────────────────────────────────────────────
  create_task: { opName: 'tasks.create' },
  update_task: { opName: 'tasks.update' },
  delete_task: { opName: 'tasks.delete' },
  reorder_task: { opName: 'tasks.reorder' },
  create_task_status: { opName: 'tasks.createStatus' },
  get_assigned_tasks: { opName: 'tasks.getAssigned' },

  // ── Search ───────────────────────────────────────────────────────────────
  regex_search: { opName: 'search.regex' },
  glob_search: { opName: 'search.glob' },
  multi_drive_search: { opName: 'search.multiDrive' },

  // ── AI agents & models ───────────────────────────────────────────────────
  // `agentPath` was decorative on every old agent tool — verified never sent
  // to any route (agents.ts module doc: "agentPath from every old tool's
  // input was decorative — verified never sent to any route").
  update_agent_config: {
    opName: 'agents.updateConfig',
    fields: { agentPath: { kind: 'dropped', reason: 'decorative only — never sent to any route (agents.ts module doc)' } },
  },
  list_agents: { opName: 'agents.list' },
  multi_drive_list_agents: { opName: 'agents.listMultiDrive' },
  ask_agent: {
    opName: 'agents.ask',
    fields: { agentPath: { kind: 'dropped', reason: 'decorative only — never sent to any route (agents.ts module doc)' } },
  },
  list_models: { opName: 'agents.listModels' },

  // ── Calendar ─────────────────────────────────────────────────────────────
  list_calendar_events: { opName: 'calendar.list' },
  get_calendar_event: { opName: 'calendar.get' },
  create_calendar_event: { opName: 'calendar.create' },
  update_calendar_event: { opName: 'calendar.update' },
  delete_calendar_event: { opName: 'calendar.delete' },
  rsvp_calendar_event: { opName: 'calendar.rsvp' },
  invite_calendar_attendees: { opName: 'calendar.inviteAttendees' },
  // D6: the route reads the target user exclusively from `?userId=`
  // (defaulting to the caller when absent) — the operation's field is named
  // `userId` to match the route, not the old tool's `targetUserId`.
  remove_calendar_attendee: {
    opName: 'calendar.removeAttendee',
    fields: { targetUserId: { kind: 'renamed', to: 'userId', reason: 'D6 — route reads ?userId=, not a targetUserId body field' } },
  },

  // ── Slash commands ───────────────────────────────────────────────────────
  list_commands: { opName: 'commands.list' },
  create_command: { opName: 'commands.create' },
  update_command: { opName: 'commands.update' },
  delete_command: { opName: 'commands.delete' },

  // ── Role management ──────────────────────────────────────────────────────
  list_drive_roles: { opName: 'roles.list' },
  get_drive_role: { opName: 'roles.get' },
  create_drive_role: { opName: 'roles.create' },
  update_drive_role: { opName: 'roles.update' },
  delete_drive_role: { opName: 'roles.delete' },
  // roles.ts module doc: fix #1765 replaced the flat single-page
  // {pageId, canView, canEdit, canShare} shape with a server-side
  // read-merge-write `permissionsPatch: Record<pageId, PagePerm>` map, so a
  // single SDK call can never wipe another page's grant. `pageId` (the only
  // v5.2.2-*required* field affected — canView/canEdit/canShare were
  // optional flags there) is absorbed into `permissionsPatch`'s keys.
  set_role_page_permissions: {
    opName: 'roles.setPagePermissions',
    fields: { pageId: { kind: 'reshaped', into: 'permissionsPatch', reason: 'fix #1765 — per-page read-merge-write patch, pageId becomes a dynamic key' } },
  },
  set_role_drive_wide_permissions: { opName: 'roles.setDriveWidePermissions' },
  remove_role_page_permissions: {
    opName: 'roles.removePagePermissions',
    fields: { pageId: { kind: 'reshaped', into: 'permissionsPatch', reason: 'fix #1765 — per-page read-merge-write patch, pageId becomes a dynamic key' } },
  },

  // ── Agent triggers ───────────────────────────────────────────────────────
  // calendar.ts operations use `eventId` throughout (matching every other
  // calendar.* operation) instead of the old trigger tools' one-off
  // `calendarEventId`.
  set_calendar_trigger: {
    opName: 'calendar.setTrigger',
    fields: { calendarEventId: { kind: 'renamed', to: 'eventId', reason: 'aligned with every other calendar.* operation\'s eventId field' } },
  },
  delete_calendar_trigger: {
    opName: 'calendar.deleteTrigger',
    fields: { calendarEventId: { kind: 'renamed', to: 'eventId', reason: 'aligned with every other calendar.* operation\'s eventId field' } },
  },
  set_task_trigger: { opName: 'tasks.setTrigger' },
  delete_task_trigger: { opName: 'tasks.deleteTrigger' },

  // ── Scheduled workflows ──────────────────────────────────────────────────
  list_workflows: { opName: 'workflows.list' },
  create_workflow: { opName: 'workflows.create' },
  update_workflow: { opName: 'workflows.update' },
  delete_workflow: { opName: 'workflows.delete' },

  // ── Members & collaborators ──────────────────────────────────────────────
  list_drive_members: { opName: 'members.list' },
  list_collaborators: { opName: 'collaborators.list' },

  // ── Conversations, channels & activity ───────────────────────────────────
  list_conversations: { opName: 'conversations.list' },
  read_conversation: { opName: 'conversations.read' },
  send_channel_message: { opName: 'channels.sendMessage' },
  delete_channel_message: { opName: 'channels.deleteMessage' },
  get_activity: { opName: 'activity.get' },
};

export interface DroppedToolEntry {
  /** Why this v5.2.2 tool has no corresponding MCP tool today. Must reference the operations-inventory.md D# row when one exists. */
  readonly reason: string;
}

/**
 * v5.2.2 tools with NO corresponding operation in the current registry, by
 * deliberate design (not an oversight) — reviewable, greppable, one entry
 * per tool, every entry with a reason.
 */
export const DROPPED_TOOLS: Readonly<Record<string, DroppedToolEntry>> = {
  // D4 (operations-inventory.md): the old tool hit the exact same route as
  // list_calendar_events (GET /api/calendar/events) and computed free/busy
  // gaps client-side over the response. The registry models that as
  // `computeFreeSlots(events, range)`, a pure function over
  // `calendar.list`'s output (packages/sdk/src/operations/calendar.ts) —
  // there is no `calendar.checkAvailability` operation and therefore no MCP
  // tool. Reachable capability: call `calendar.list` (`list_calendar_events`)
  // then compute free slots over its `events` array (the same math
  // `computeFreeSlots` runs, exported for any caller that wants it — though,
  // unlike the old tool, it is not itself callable as an MCP tool).
  check_calendar_availability: {
    reason:
      'D4 — collapsed into computeFreeSlots(events, range), a pure function over calendar.list\'s output; not registered as its own operation, so no MCP tool exists for it',
  },
};
