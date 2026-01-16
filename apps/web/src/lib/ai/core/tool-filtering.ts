/**
 * Simple tool filtering for read-only mode and web search
 *
 * Replaces the complex role-based permission system with simple
 * toggles that filter out specific tools based on user settings.
 */

// Tools that modify content (excluded in read-only mode)
const WRITE_TOOLS = new Set([
  // Page write operations
  'create_page',
  'rename_page',
  'replace_lines',
  'move_page',
  'edit_sheet_cells',
  // Drive operations
  'create_drive',
  'rename_drive',
  // Unified trash/restore (pages and drives)
  'trash',
  'restore',
  // Agent operations
  'update_agent_config',
  // Task operations
  'update_task',
]);

// Web search tools (excluded when web search is disabled)
const WEB_SEARCH_TOOLS = new Set(['web_search']);

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
 * Get list of allowed tools for display purposes
 */
export function getToolsSummary(isReadOnly: boolean, webSearchEnabled = true): {
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
    'get_activity',
    // Search tools
    'regex_search',
    'glob_search',
    'multi_drive_search',
    'web_search',
    // Agent communication
    'ask_agent',
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
