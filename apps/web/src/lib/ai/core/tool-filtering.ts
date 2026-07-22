/**
 * Simple tool filtering for read-only mode and web search
 *
 * Replaces the complex role-based permission system with simple
 * toggles that filter out specific tools based on user settings.
 */

import { SANDBOX_GIT_TOOL_NAMES } from '../tools/sandbox-git-tools';
import { parseIntegrationToolName } from '@pagespace/lib/integrations/converter/ai-sdk';

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
  // Image generation — creates a FILE page in the drive
  'generate_image',
  // Sandbox / code-execution operations — all mutate the persistent sandbox
  // filesystem or a remote. bash can run arbitrary mutations, so it is excluded
  // in read-only mode too. Read-only sandbox tools (readFile, git_status,
  // git_diff, git_log, git_show, git_blame, gh_pr_list, gh_pr_view, gh_pr_diff,
  // gh_pr_checks, gh_pr_thread_list, gh_run_list, gh_run_view, gh_workflow_list,
  // gh_issue_list, gh_issue_view, gh_repo_view, gh_repo_list, gh_search,
  // gh_label_list) are intentionally NOT listed and remain available.
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
  'git_revert',
  'git_checkout',
  'git_branch',
  'git_fetch',
  'git_pull',
  'git_push',
  'gh_pr_create',
  'gh_pr_merge',
  'gh_pr_checkout',
  'gh_pr_review',
  'gh_pr_review_comment',
  'gh_pr_comment',
  'gh_pr_edit',
  'gh_pr_update_branch',
  'gh_pr_thread_resolve',
  'gh_pr_close',
  'gh_pr_reopen',
  'gh_pr_ready',
  'gh_run_rerun',
  'gh_workflow_run',
  'gh_issue_create',
  'gh_issue_comment',
  'gh_issue_edit',
  'gh_issue_close',
  'gh_issue_reopen',
  'gh_repo_fork',
  'gh_repo_create',
]);

// Web search tools (excluded when web search is disabled)
const WEB_SEARCH_TOOLS = new Set(['web_search', 'web_fetch']);

// Tools that let the agent discover or switch to a different machine —
// dropped when the conversation is bound to one specific machine via a
// Machine Pane binding (deriveMachinePaneBinding). The bound machine is the
// only one this conversation may ever act on, so offering a way to leave it
// is moot.
const MACHINE_BINDING_LOCKED_TOOLS = new Set(['switch_machine', 'list_machines']);

/**
 * The SESSION FAMILY — the orchestration surface of a machine-BOUND
 * conversation, and only of a machine-bound one.
 *
 * Registered by ADDITION rather than by filtering (see
 * `withSessionFamilyTools`): these tools are meaningless without a derived
 * handle set to resolve their targets against, and a drive agent's tool set
 * must stay byte-identical to what it is today. Adding them to the baseline
 * registry and filtering them back out for everyone else would leak them into
 * every other surface that composes `pageSpaceTools` without the binding
 * filter (the global assistant, /v1 completions, consult, workflows, and the
 * agent-config tool listings).
 */
export const SESSION_FAMILY_TOOL_NAMES: readonly string[] = [
  'list_sessions',
  'add_session',
  'move_session',
  'kill_session',
  'read_session',
  'send_session',
];

// Image-generation tools (a runtime composer toggle, like web search — filtered
// independently of the saved per-agent allow-list).
const IMAGE_GEN_TOOLS = new Set(['generate_image']);

// Presence of any of these in a request's tool set means the agent already has
// a full git/gh CLI toolkit — used to detect overlap with the GitHub OAuth
// integration tools below. Sourced from sandbox-git-tools.ts (single source of
// truth, sync-checked by that file's own test suite).
const SANDBOX_GIT_TOOL_NAME_SET = new Set(SANDBOX_GIT_TOOL_NAMES);

/**
 * Whether the sandbox git/gh CLI toolkit is active — i.e. any of its tool
 * names appear in a resolved tool set. Must be checked against the tool set
 * BEFORE per-agent tool-exposure-mode deferral (search mode moves non-core
 * tools behind execute_tool, hiding these names from a top-level key scan).
 */
export function hasSandboxGitTools(tools: Record<string, unknown>): boolean {
  return Object.keys(tools).some((name) => SANDBOX_GIT_TOOL_NAME_SET.has(name));
}

/**
 * Suppress GitHub OAuth integration tools when the sandbox git/gh CLI toolkit is
 * already registered in the current tool set — the two overlap in capability
 * (browsing repos, reviewing PRs, filing issues), and offering both surfaces for
 * the same GitHub account is redundant and confuses tool selection. Other
 * providers' integration tools (Slack, etc.) are untouched.
 */
export function suppressGithubIntegrationTools<T>(
  integrationTools: Record<string, T>,
  currentTools: Record<string, unknown>
): Record<string, T> {
  if (!hasSandboxGitTools(currentTools)) return integrationTools;
  return Object.fromEntries(
    Object.entries(integrationTools).filter(([name]) => parseIntegrationToolName(name)?.providerSlug !== 'github')
  );
}

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
 * Check if a tool is an image-generation tool
 */
export function isImageGenTool(toolName: string): boolean {
  return IMAGE_GEN_TOOLS.has(toolName);
}

/**
 * Filter tools based on the image-generation toggle.
 * Returns all tools when enabled, or excludes generate_image when disabled.
 */
export function filterToolsForImageGen<T>(
  tools: Record<string, T>,
  imageGenEnabled: boolean
): Record<string, T> {
  if (imageGenEnabled) return tools;

  return Object.fromEntries(
    Object.entries(tools).filter(([name]) => !isImageGenTool(name))
  );
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
 * Filter tools based on machine-pane binding.
 * Returns all tools when not bound, or drops switch_machine/list_machines
 * when the conversation is bound to a specific machine.
 */
export function filterToolsForMachineBinding<T>(
  tools: Record<string, T>,
  isBound: boolean
): Record<string, T> {
  if (!isBound) return tools;

  return Object.fromEntries(
    Object.entries(tools).filter(([name]) => !MACHINE_BINDING_LOCKED_TOOLS.has(name))
  );
}

/**
 * Register the session family for a machine-BOUND conversation.
 *
 * The exact counterpart of `filterToolsForMachineBinding`: that one takes away
 * what a bound conversation must not have (`switch_machine`/`list_machines` —
 * it cannot leave its machine), this one adds what only a bound conversation
 * can use. An unbound conversation gets its input back UNCHANGED — same object
 * contents, same key order — because the drive-agent tool set is not this
 * epic's to change.
 */
export function withSessionFamilyTools<T>(
  tools: Record<string, T>,
  sessionTools: Record<string, T>,
  isBound: boolean
): Record<string, T> {
  if (!isBound) return tools;
  return { ...tools, ...sessionTools };
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

