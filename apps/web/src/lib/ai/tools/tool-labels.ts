/**
 * What a tool call is CALLED, in words a person reads.
 *
 * One vocabulary, two surfaces. The thread renders a tool call in a collapsible
 * card; a voice call has no card and shows the same thing as the status line
 * under the waveform while the model is off doing it. A second copy of these
 * strings for the spoken surface would drift the first time a tool was added,
 * and the drift would be invisible — nobody diffs a label table.
 *
 * This lives in `lib/` rather than beside the renderer because a reducer needs
 * it: `realtime/session-state.ts` is a pure module with no business importing
 * from `components/`. The renderer keeps its own integration-label override on
 * top, which is the one part that depends on the integrations registry.
 *
 * Pure: no I/O, no clock, no randomness, no module-level mutable state.
 */

export const TOOL_NAME_MAP: Record<string, string> = {
  // Drive tools
  'list_drives': 'Workspaces',
  'create_drive': 'Create Workspace',
  'rename_drive': 'Rename Workspace',
  'update_drive_context': 'Update Context',
  'set_home_page': 'Set Home Page',
  // Member tools
  'list_drive_members': 'Members',
  'list_collaborators': 'Collaborators',
  // Role management tools
  'list_drive_roles': 'Roles',
  'get_drive_role': 'Role',
  'create_drive_role': 'Create Role',
  'update_drive_role': 'Update Role',
  'delete_drive_role': 'Delete Role',
  'set_role_page_permissions': 'Set Role Page Access',
  'set_role_drive_wide_permissions': 'Set Role Drive Access',
  'remove_role_page_permissions': 'Remove Role Page Access',
  // Page read tools
  'list_pages': 'Pages',
  'read_page': 'Read Page',
  'list_trash': 'Trash',
  'list_conversations': 'Conversations',
  'read_conversation': 'Conversation',
  'send_channel_message': 'Send Message',
  'delete_channel_message': 'Delete Message',
  // Page write tools
  'replace_lines': 'Edit Document',
  'insert_content': 'Insert Content',
  'create_page': 'Create Page',
  'rename_page': 'Rename Page',
  'trash_page': 'Move to Trash',
  'trash_drive': 'Move Drive to Trash',
  'restore_page': 'Restore',
  'restore_drive': 'Restore Drive',
  'move_page': 'Move Page',
  'read_sheet': 'Read Sheet',
  'edit_sheet_cells': 'Edit Sheet',
  // Search tools
  'regex_search': 'Search',
  'glob_search': 'Find Pages',
  'multi_drive_search': 'Search All',
  // Task tools
  'update_task': 'Update Task',
  'create_task': 'Create Task',
  'delete_task': 'Delete Task',
  'reorder_task': 'Reorder Task',
  'get_assigned_tasks': 'Assigned Tasks',
  'create_task_status': 'Create Status',
  // Agent tools
  'update_agent_config': 'Configure Agent',
  'list_agents': 'Agents',
  'multi_drive_list_agents': 'All Agents',
  'ask_agent': 'Ask Agent',
  'ask_user': 'Question',
  // Web
  'web_search': 'Web Search',
  'web_fetch': 'Fetch Page',
  // Activity
  'get_activity': 'Activity',
  // Calendar tools
  'list_calendar_events': 'Calendar',
  'get_calendar_event': 'Event',
  'check_calendar_availability': 'Availability',
  'create_calendar_event': 'Create Event',
  'update_calendar_event': 'Update Event',
  'delete_calendar_event': 'Delete Event',
  'rsvp_calendar_event': 'RSVP',
  'invite_calendar_attendees': 'Invite Attendees',
  'remove_calendar_attendee': 'Remove Attendee',
  // Workflow tools
  'create_workflow': 'Create Workflow',
  'list_workflows': 'Workflows',
  'update_workflow': 'Update Workflow',
  'delete_workflow': 'Delete Workflow',
};

/**
 * A tool's display name: the curated label when there is one, otherwise the
 * name title-cased, which reads acceptably for everything not worth curating
 * (`rename_page` → "Rename Page").
 */
export const formatToolName = (toolName: string): string =>
  TOOL_NAME_MAP[toolName] ??
  toolName
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

/**
 * The subject fields, in the order they are tried, and whether the value is
 * free text that needs trimming.
 *
 * ORDER IS BEHAVIOUR, not taste: a call carrying both `name` and `repo` is
 * labelled by its `name`, and this list is a faithful port of the sequence the
 * thread renderer already used. Only `query` is trimmed, because only `query`
 * is arbitrary user text — a long page title is still the page's title, and
 * clipping it would make the label wrong rather than tidy.
 */
const SUBJECT_FIELDS: readonly { readonly field: string; readonly trim?: true }[] = [
  { field: 'title' },
  { field: 'name' },
  { field: 'query', trim: true },
  { field: 'pattern' },
  { field: 'driveSlug' },
  { field: 'channel' },
  { field: 'repo' },
];

/** Where `owner`/`repo` is tried, matching the renderer's original sequence. */
const OWNER_REPO_AFTER = 'driveSlug';

const MAX_QUERY_CHARS = 30;

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/**
 * The tool's name plus what it is acting on, from its arguments.
 *
 * `label` is passed in rather than derived so a caller that has already
 * resolved a better name — the thread renderer overrides integration tools from
 * the integrations registry — does not lose it here.
 *
 * Arguments arrive as whatever the model sent, so every read is defensive: a
 * label is never worth throwing over.
 */
export const describeToolCall = (
  toolName: string,
  input: unknown,
  label: string = formatToolName(toolName),
): string => {
  if (typeof input !== 'object' || input === null) return label;
  const params = input as Record<string, unknown>;

  const ownerRepo = (): string | undefined => {
    const owner = asString(params.owner);
    const repo = asString(params.repo);
    if (!owner || !repo) return undefined;
    const path = asString(params.path);
    return `${owner}/${repo}${path ? `/${path}` : ''}`;
  };

  for (const { field, trim } of SUBJECT_FIELDS) {
    const value = asString(params[field]);
    if (value) {
      const subject = trim && value.length > MAX_QUERY_CHARS
        ? `${value.slice(0, MAX_QUERY_CHARS)}...`
        : value;
      return `${label}: ${subject}`;
    }
    if (field === OWNER_REPO_AFTER) {
      const composed = ownerRepo();
      if (composed) return `${label}: ${composed}`;
    }
  }

  return label;
};
