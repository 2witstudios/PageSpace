/**
 * Simple tool filtering for read-only mode and web search
 *
 * Replaces the complex role-based permission system with simple
 * toggles that filter out specific tools based on user settings.
 */

// Tools that modify content (excluded in read-only mode; also used by elision to protect side-effectful results)
export const WRITE_TOOLS = new Set([
  // Page write operations
  'create_page',
  'rename_page',
  'replace_lines',
  'insert_content',
  'move_page',
  'edit_sheet_cells',
  // Drive operations
  'create_drive',
  'rename_drive',
  'update_drive_context',
  'set_home_page',
  // Explicit per-entity trash/restore (pages and drives)
  'trash_page',
  'trash_drive',
  'restore_page',
  'restore_drive',
  // Agent operations
  'update_agent_config',
  // Task operations
  'update_task',
  'create_task',
  'delete_task',
  'reorder_task',
  // Channel operations
  'send_channel_message',
  'delete_channel_message',
  // Calendar write operations
  'create_calendar_event',
  'update_calendar_event',
  'delete_calendar_event',
  'rsvp_calendar_event',
  'invite_calendar_attendees',
  'remove_calendar_attendee',
  // Workflow (cron) operations
  'create_workflow',
  'update_workflow',
  'delete_workflow',
  // Trigger operations
  'set_calendar_trigger',
  'delete_calendar_trigger',
  'set_task_trigger',
  'delete_task_trigger',
  // Role management operations
  'create_drive_role',
  'update_drive_role',
  'delete_drive_role',
  'set_role_page_permissions',
  'set_role_drive_wide_permissions',
  'remove_role_page_permissions',
  // Command operations
  'create_command',
  'update_command',
  'delete_command',
  // Sandbox / code-execution operations — all mutate the persistent sandbox
  // filesystem or a remote. bash can run arbitrary mutations, so it is excluded
  // in read-only mode too. Read-only sandbox tools (readFile, git_status,
  // git_diff, git_log, gh_pr_list, gh_pr_view, gh_pr_diff, gh_pr_checks,
  // gh_run_list, gh_run_view, gh_issue_list, gh_issue_view) are
  // intentionally NOT listed and remain available.
  'bash',
  'writeFile',
  'editFile',
  'git_clone',
  'git_init',
  'git_config',
  'git_remote_add',
  'git_add',
  'git_reset',
  'git_stash',
  'git_commit',
  'git_merge',
  'git_rebase',
  'git_checkout',
  'git_branch',
  'git_fetch',
  'git_pull',
  'git_push',
  'gh_pr_create',
  'gh_pr_merge',
  'gh_pr_checkout',
  'gh_pr_review',
  'gh_pr_close',
  'gh_pr_reopen',
  'gh_pr_ready',
  'gh_issue_create',
]);

// Web search tools (excluded when web search is disabled)
const WEB_SEARCH_TOOLS = new Set(['web_search', 'web_fetch']);

// Tools that require account-level (unscoped) access — excluded entirely from
// a drive-scoped MCP token's tool list, mirroring the isMcpScoped() call-time
// guard in the tool's own execute() (e.g. drive-tools.ts create_drive). This
// hides the tool from listing instead of only rejecting it after the model
// tries to call it.
export const ACCOUNT_LEVEL_ONLY_TOOLS = new Set(['create_drive']);

/**
 * Check if a tool modifies content
 */
export function isWriteTool(toolName: string): boolean {
  return WRITE_TOOLS.has(toolName);
}

/**
 * Filter tools based on read-only mode
 * Returns all tools if not read-only, or only read tools if read-only
 */
export function filterToolsForReadOnly<T>(
  tools: Record<string, T>,
  isReadOnly: boolean
): Record<string, T> {
  if (!isReadOnly) return tools;

  return Object.fromEntries(
    Object.entries(tools).filter(([name]) => !isWriteTool(name))
  );
}

/**
 * Check if a tool is a web search tool
 */
export function isWebSearchTool(toolName: string): boolean {
  return WEB_SEARCH_TOOLS.has(toolName);
}

/**
 * Check if a tool requires account-level (unscoped) access
 */
export function isAccountLevelOnlyTool(toolName: string): boolean {
  return ACCOUNT_LEVEL_ONLY_TOOLS.has(toolName);
}

/**
 * Filter tools based on MCP drive scope.
 * A drive-scoped token (isScoped) cannot see account-level-only tools like
 * create_drive — they would fail at call time anyway, so hide them from listing.
 */
export function filterToolsForMcpScope<T>(
  tools: Record<string, T>,
  isScoped: boolean
): Record<string, T> {
  if (!isScoped) return tools;

  return Object.fromEntries(
    Object.entries(tools).filter(([name]) => !isAccountLevelOnlyTool(name))
  );
}

/**
 * Filter tools based on web search toggle
 * Returns all tools if web search enabled, or excludes web_search if disabled
 */
export function filterToolsForWebSearch<T>(
  tools: Record<string, T>,
  webSearchEnabled: boolean
): Record<string, T> {
  if (webSearchEnabled) return tools;

  return Object.fromEntries(
    Object.entries(tools).filter(([name]) => !isWebSearchTool(name))
  );
}

/**
 * Combined tool filtering - applies both read-only and web search filters
 */
export function filterTools<T>(
  tools: Record<string, T>,
  options: { isReadOnly?: boolean; webSearchEnabled?: boolean }
): Record<string, T> {
  let filtered = tools;

  if (options.isReadOnly) {
    filtered = filterToolsForReadOnly(filtered, true);
  }

  if (options.webSearchEnabled === false) {
    filtered = filterToolsForWebSearch(filtered, false);
  }

  return filtered;
}

/**
 * Build the tool set for a Page AI request from a baseline tool registry.
 *
 * The popover toggles in the chat composer are the source of truth at request
 * time. The page's saved enabledTools array seeds those toggles on the client
 * but is intentionally NOT consulted here — otherwise a hidden allow-list
 * silently overrides whatever the user just clicked.
 */
export function buildPageAITools<T>(
  baseline: Record<string, T>,
  options: { isReadOnly: boolean; webSearchEnabled: boolean }
): Record<string, T> {
  const afterReadOnly = filterToolsForReadOnly(baseline, options.isReadOnly);
  return filterToolsForWebSearch(afterReadOnly, options.webSearchEnabled);
}

/**
 * Get list of allowed tools for display purposes
 */
export function getToolsSummary(isReadOnly: boolean, webSearchEnabled = true): {
  allowed: string[];
  denied: string[];
} {
  const allTools = [
    // Read tools
    'list_drive_members',
    'list_collaborators',
    'list_drive_roles',
    'get_drive_role',
    'list_drives',
    'list_pages',
    'read_page',
    'list_trash',
    'list_conversations',
    'read_conversation',
    'list_agents',
    'multi_drive_list_agents',
    'get_activity',
    'get_assigned_tasks',
    // Calendar read tools
    'list_calendar_events',
    'get_calendar_event',
    'check_calendar_availability',
    // Search tools
    'regex_search',
    'glob_search',
    'multi_drive_search',
    'web_search',
    'web_fetch',
    // Agent communication
    'ask_agent',
    // Model catalog (read-only)
    'list_models',
    // Command read
    'list_commands',
    // Workflow read
    'list_workflows',
    // Write tools
    ...Array.from(WRITE_TOOLS),
  ];

  if (!isReadOnly && webSearchEnabled) {
    return { allowed: allTools, denied: [] };
  }

  const allowed = allTools.filter((name) => {
    if (isReadOnly && isWriteTool(name)) return false;
    if (!webSearchEnabled && isWebSearchTool(name)) return false;
    return true;
  });

  const denied = allTools.filter((name) => {
    if (isReadOnly && isWriteTool(name)) return true;
    if (!webSearchEnabled && isWebSearchTool(name)) return true;
    return false;
  });

  return { allowed, denied };
}
