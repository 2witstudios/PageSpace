/**
 * Simple tool filtering for read-only mode
 *
 * Replaces the complex role-based permission system with a simple
 * read-only toggle that filters out write/delete/create operations.
 */

// Tools that modify content (excluded in read-only mode)
const WRITE_TOOLS = new Set([
  // Page write operations
  'create_page',
  'rename_page',
  'replace_lines',
  'insert_lines',
  'trash_page',
  'restore_page',
  'move_page',
  // Drive operations
  'create_drive',
  'rename_drive',
  'trash_drive',
  'restore_drive',
  // Agent operations
  'create_agent',
  'update_agent_config',
  // Task operations
  'create_task_list',
  'update_task',
]);

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
 * Get list of allowed tools for display purposes
 */
export function getToolsSummary(isReadOnly: boolean): {
  allowed: string[];
  denied: string[];
} {
  const allTools = [
    // Read tools
    'list_drives',
    'list_pages',
    'read_page',
    'list_trash',
    'list_agents',
    'multi_drive_list_agents',
    'get_task_list',
    // Search tools
    'regex_search',
    'glob_search',
    'multi_drive_search',
    'search_pages',
    'web_search',
    // Agent communication
    'ask_agent',
    // Write tools
    ...Array.from(WRITE_TOOLS),
  ];

  if (!isReadOnly) {
    return { allowed: allTools, denied: [] };
  }

  const allowed = allTools.filter((name) => !isWriteTool(name));
  const denied = allTools.filter((name) => isWriteTool(name));

  return { allowed, denied };
}
