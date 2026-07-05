/**
 * System Prompt Builder for PageSpace AI
 *
 * Single unified prompt with optional read-only mode.
 * Replaces the complex 3-role system with simple, trust-the-model approach.
 */

export interface ContextInfo {
  driveName?: string;
  driveSlug?: string;
  driveId?: string;
  pagePath?: string;
  pageType?: string;
  breadcrumbs?: string[];
}

export interface PersonalizationInfo {
  bio?: string;
  writingStyle?: string;
  rules?: string;
  enabled: boolean;
}

const CORE_PROMPT = `You are PageSpace AI. You can explore, read, and modify the user's workspace. Balance conversation with action based on what the user needs.`;

const BEHAVIOR_PROMPT = `APPROACH:
• When ideas are forming, engage in conversation before reaching for tools
• When intent is clear (find, create, show me), use tools right away
• Complete what you start, don't overextend beyond what was asked
• At the end of a turn — whenever finish is called or the last step completes — send one message to the user summarising what was done. A string of silent tool calls with no closing message is a broken UX, not an efficient one.
• If the tool calls produced nothing worth reporting, still close with a one-liner so the user knows the turn is done.

STYLE:
• Skip preambles ("I'll help you...") and postambles ("Let me know if...")
• Skip flattery ("Great question!"). Respond directly.
• Be concise but conversational - like a knowledgeable colleague
• Match user energy - conversational when exploring, efficient when executing`;

export const TOOL_DISCOVERY_PROMPT = `TOOLS:
Core tools (list/read drives and pages, search, create, edit content) can be called directly.
All other tools are listed below — call execute_tool({tool_name, parameters}) to run them. Use tool_search("select:tool_name") to get parameter schemas first.`;

const CATEGORY_MAP: Record<string, string> = {
  create_drive: 'drive', rename_drive: 'drive', update_drive_context: 'drive',
  list_trash: 'pages', list_conversations: 'pages', read_conversation: 'pages',
  rename_page: 'pages', move_page: 'pages', edit_sheet_cells: 'pages',
  trash_page: 'pages', trash_drive: 'pages', restore_page: 'pages', restore_drive: 'pages',
  glob_search: 'search', web_fetch: 'search', web_search: 'search',
  update_task: 'tasks', create_task: 'tasks', delete_task: 'tasks', reorder_task: 'tasks', get_assigned_tasks: 'tasks',
  set_task_trigger: 'tasks', delete_task_trigger: 'tasks', create_task_status: 'tasks',
  update_agent_config: 'agents', list_agents: 'agents', multi_drive_list_agents: 'agents', ask_agent: 'agents', list_models: 'agents',
  get_activity: 'activity',
  list_calendar_events: 'calendar', get_calendar_event: 'calendar', check_calendar_availability: 'calendar',
  create_calendar_event: 'calendar', update_calendar_event: 'calendar', delete_calendar_event: 'calendar',
  rsvp_calendar_event: 'calendar', invite_calendar_attendees: 'calendar', remove_calendar_attendee: 'calendar',
  set_calendar_trigger: 'calendar', delete_calendar_trigger: 'calendar',
  send_channel_message: 'channels',
  create_workflow: 'workflows', list_workflows: 'workflows', update_workflow: 'workflows', delete_workflow: 'workflows',
  list_drive_members: 'permissions', list_collaborators: 'permissions', list_drive_roles: 'permissions',
  get_drive_role: 'permissions', create_drive_role: 'permissions', update_drive_role: 'permissions', delete_drive_role: 'permissions',
  set_role_page_permissions: 'permissions', set_role_drive_wide_permissions: 'permissions', remove_role_page_permissions: 'permissions',
  list_commands: 'commands', create_command: 'commands', update_command: 'commands', delete_command: 'commands',
};

export function buildNonCoreToolNamesPrompt(toolNames: string[]): string {
  if (toolNames.length === 0) return '';

  const groups = new Map<string, string[]>();
  for (const name of toolNames) {
    const category = CATEGORY_MAP[name] ?? 'other';
    const bucket = groups.get(category) ?? [];
    bucket.push(name);
    groups.set(category, bucket);
  }

  const lines = Array.from(groups.entries())
    .map(([category, names]) => `  ${category}: ${names.join(', ')}`)
    .join('\n');

  return `NON-CORE TOOLS (use execute_tool to call; use tool_search("select:tool_name") for parameter schemas):\n${lines}`;
}

const READ_ONLY_CONSTRAINT = `READ-ONLY MODE:
• You cannot modify, create, or delete any content
• Focus on exploring, analyzing, and planning
• Create actionable plans for the user to execute later`;

// Appended only when the code-execution sandbox tools are registered for the
// request (same gate as ai-tools.ts). Deliberately short — the basics that make
// the sandbox smooth to use, not a wall of instructions.
const SANDBOX_INSTRUCTIONS = `CODE SANDBOX:
• Paths always resolve from /workspace, relative or absolute (e.g. "repo/src/x.ts" and "/workspace/repo/src/x.ts" are the same file) — one rule for every tool. Most tools take path (file tools, and git_clone/git_init for their destination); bash and the rest of the git_*/gh_* tools take cwd for their working directory instead. A field from the wrong family (e.g. cwd on writeFile) is rejected, not silently ignored.
• The /workspace filesystem persists across turns and tool calls in this conversation — your clone, branch checkout, and commits are still there next turn. Check state before recreating it: git_status / git_branch before re-cloning or branching; gh_pr_list / gh_pr_view before opening a PR. To update an open PR, push more commits to its branch (force-push is fine for your PR branch, never to main/master) — don't open a second PR.
• Each tool call is a fresh process — cd does NOT persist between calls (the filesystem persists, the shell does not).
• bash has NO GitHub credentials. For anything touching GitHub (clone/fetch/pull/push, PRs, issues) use the dedicated git_*/gh_* tools — they carry your connected GitHub auth.
• Use editFile for targeted string edits; writeFile rewrites the whole file.
• Work on a new branch unless told to work on main/master. Check for AGENTS.md/CLAUDE.md in the repo root and follow it. Install dependencies before running tests or a typecheck — pass bash's timeoutMs (up to 200000ms) if a command needs more than the 120s default.
• Key tools (call via execute_tool; no need to tool_search these): bash, readFile, writeFile, editFile, git_clone, git_checkout, git_add, git_commit, git_push, gh_pr_create, gh_pr_list, gh_pr_view, gh_pr_diff, gh_pr_checks, gh_run_list, gh_run_view, gh_pr_review, gh_pr_close.`;

/**
 * Build personalization prompt section from user preferences
 */
export function buildPersonalizationPrompt(personalization?: PersonalizationInfo): string | null {
  if (!personalization?.enabled) {
    return null;
  }

  const sections: string[] = [];

  if (personalization.bio?.trim()) {
    sections.push(`ABOUT THE USER:\n${personalization.bio.trim()}`);
  }

  if (personalization.writingStyle?.trim()) {
    sections.push(`COMMUNICATION PREFERENCES:\n${personalization.writingStyle.trim()}`);
  }

  if (personalization.rules?.trim()) {
    sections.push(`USER RULES:\n${personalization.rules.trim()}`);
  }

  if (sections.length === 0) {
    return null;
  }

  return `# USER PERSONALIZATION\n\n${sections.join('\n\n')}`;
}

/**
 * Build context-specific prompt section
 */
function buildContextPrompt(
  contextType: 'dashboard' | 'drive' | 'page',
  contextInfo?: ContextInfo
): string {
  if (!contextInfo) {
    return `CONTEXT: Operating in ${contextType} mode.`;
  }

  switch (contextType) {
    case 'dashboard':
      return `DASHBOARD CONTEXT:
• Operating across all workspaces
• Focus on cross-workspace tasks and personal productivity`;

    case 'drive':
      return `DRIVE CONTEXT:
• Current Workspace: "${contextInfo.driveName}" (Slug: ${contextInfo.driveSlug}, ID: ${contextInfo.driveId})
• When users say "here" or "this workspace", they mean: ${contextInfo.driveSlug}`;

    case 'page':
      return `PAGE CONTEXT:
• Location: ${contextInfo.pagePath}
• Type: ${contextInfo.pageType}
• Path: ${contextInfo.breadcrumbs?.join(' > ')}
• When users say "here", they mean this page`;

    default:
      return `CONTEXT: ${contextType} mode`;
  }
}

/**
 * Build a complete system prompt
 */
export function buildSystemPrompt(
  contextType: 'dashboard' | 'drive' | 'page',
  contextInfo?: ContextInfo,
  isReadOnly: boolean = false,
  personalization?: PersonalizationInfo,
  codeExecutionEnabled: boolean = false
): string {
  const contextPrompt = buildContextPrompt(contextType, contextInfo);
  const personalizationPrompt = buildPersonalizationPrompt(personalization);

  const sections = [
    '# PAGESPACE AI',
    isReadOnly
      ? CORE_PROMPT.replace(
          'modify',
          'explore (read-only mode - no modifications)'
        )
      : CORE_PROMPT,
    personalizationPrompt,
    contextPrompt,
    BEHAVIOR_PROMPT,
    isReadOnly ? READ_ONLY_CONSTRAINT : null,
    codeExecutionEnabled ? SANDBOX_INSTRUCTIONS : null,
  ].filter(Boolean);

  return sections.join('\n\n');
}

/**
 * Get welcome message
 */
export function getWelcomeMessage(
  isReadOnly: boolean,
  isNew: boolean = false
): string {
  const prefix = isNew ? 'Welcome! ' : '';

  if (isReadOnly) {
    return `${prefix}I'm in read-only mode. I can explore and analyze but won't make changes. What would you like to understand?`;
  }

  return `${prefix}I can help explore, understand, and work on your content. What would you like to work on?`;
}

/**
 * Get error message
 */
export function getErrorMessage(error: string): string {
  return `Issue: ${error}. Would you like me to try a different approach?`;
}

/**
 * Estimate token count for system prompt
 * Rough estimate: 4 characters per token
 */
export function estimateSystemPromptTokens(prompt: string): number {
  return Math.ceil(prompt.length / 4);
}
