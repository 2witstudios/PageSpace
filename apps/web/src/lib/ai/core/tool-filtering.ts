/**
 * Simple tool filtering for read-only mode and web search
 *
 * Replaces the complex role-based permission system with simple
 * toggles that filter out specific tools based on user settings.
 */

import { SANDBOX_CORE_TOOL_NAMES } from '../tools/sandbox-tools';
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
  // Session/shell-family MUTATIONS. list_sessions, read_session and read_shell
  // are reads and stay available; the rest spawn, drive and kill sessions and
  // shells — and spawn_session/send_session run a full agent loop in the
  // target, which can execute arbitrary shell commands. A read-only
  // conversation that could still call them would be read-only in name only.
  'spawn_session',
  'send_session',
  'kill_session',
  'spawn_shell',
  'send_shell',
  'kill_shell',
]);

// Web search tools (excluded when web search is disabled)
const WEB_SEARCH_TOOLS = new Set(['web_search', 'web_fetch']);

/**
 * The SESSION + SHELL families — the agent-session orchestration surface
 * (spawn/send/read/kill workers; spawn/send/read/kill PTY shells in the
 * caller's own session's sandbox). `buildPageSpaceTools` registers the
 * chat-only session subfamily unconditionally (sessions are free on every
 * plan and every deployment) and the shell subfamily alongside bash/git
 * behind the CODE_EXECUTION kill-switch; the tools resolve the caller's
 * SESSION from its conversation at call time, so there is no binding to
 * gate registration on.
 *
 * Exported for the read-only DRIFT GUARD in this module's tests: every mutating
 * member must appear in `WRITE_TOOLS` (or a read-only agent could spawn a shell
 * and write through it, defeating the read-only promise), and every read verb
 * must NOT (or a read-only agent could not even observe its own sessions). A
 * tenth tool added to the family without a matching WRITE_TOOLS decision fails
 * that test rather than silently picking the wrong default.
 */
export const SESSION_FAMILY_TOOL_NAMES: readonly string[] = [
  'list_sessions',
  'spawn_session',
  'send_session',
  'read_session',
  'kill_session',
  'spawn_shell',
  'send_shell',
  'read_shell',
  'kill_shell',
];

/**
 * The two session verbs that CREATE OR FEED A WORKER — the ones that leave
 * something running after they return. list/read/kill_session stay out of this
 * set: they are direct DB/stream operations that start nothing.
 */
export const WORKER_DISPATCH_TOOL_NAMES: ReadonlySet<string> = new Set([
  'spawn_session',
  'send_session',
]);

/**
 * Strip the worker-dispatch pair from an execution whose WORKSPACE DOES NOT
 * OUTLIVE IT.
 *
 * This used to be `filterToolsForEphemeralWorkspace`, and it used to guard a
 * credential: dispatch relayed the calling user's browser cookie, so any surface
 * without one advertised two tools whose dispatch could only refuse (review
 * #2326). That reason is GONE — dispatch signs its own hop now and needs no
 * ambient credential — and MCP/API-key surfaces no longer strip anything.
 *
 * What remains is the reason that was always structural rather than incidental,
 * and it applies to workflow runs only: a run executes against a RUN-SCOPED
 * session that its `finally` ends the moment the run finishes. A fire-and-forget
 * worker dispatched without `wait: true` would outlive its own workspace —
 * losing its Sprite mid-call, or re-provisioning after cleanup already ran. A
 * workflow run is a single bounded turn; it delegates by finishing, not by
 * leaving detached workers behind.
 *
 * Lifting this is a real change with a real fix (teach `releaseWorkflowSession`
 * to skip teardown while the run-scoped workspace still holds workers other than
 * the run's own), deliberately not bundled with the credential work.
 */
export function filterToolsForEphemeralWorkspace<T>(
  tools: Record<string, T>,
  workspaceOutlivesRun: boolean
): Record<string, T> {
  if (workspaceOutlivesRun) return tools;
  return Object.fromEntries(
    Object.entries(tools).filter(([name]) => !WORKER_DISPATCH_TOOL_NAMES.has(name))
  );
}

/**
 * The WHOLE sandbox tool surface — the three families a `sandboxEnabled: false`
 * agent must not see: core execution (bash/files), the git+gh CLI toolkit, and
 * session/shell orchestration (whose entire point is the sandbox a session
 * lazily owns). The per-agent settings switch (`pages.sandboxEnabled`,
 * successor to the old machineAccess toggle + MACHINE_TOOL_NAMES filter) gates
 * these BOTH at listing time (the settings tab's Default Tools) and at request
 * time (`filterToolsForSandboxEnablement` below) — hiding a tool from a picker
 * is not a gate. The env kill-switch and per-call `canRunCode` remain the
 * security boundaries underneath; this is agent configuration, not authz.
 */
export const SANDBOX_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...SANDBOX_CORE_TOOL_NAMES,
  ...SANDBOX_GIT_TOOL_NAMES,
  ...SESSION_FAMILY_TOOL_NAMES,
]);

/**
 * Apply the per-agent sandbox switch: `sandboxEnabled: false` (the default —
 * code execution is opt-in per agent, as machineAccess was) strips every
 * sandbox-family tool from the set. Provisioning stays lazy and automatic for
 * an ENABLED agent — this filter is the only thing the switch controls.
 */
export function filterToolsForSandboxEnablement<T>(
  tools: Record<string, T>,
  sandboxEnabled: boolean
): Record<string, T> {
  if (sandboxEnabled) return tools;
  return Object.fromEntries(
    Object.entries(tools).filter(([name]) => !SANDBOX_TOOL_NAMES.has(name))
  );
}

/**
 * The COMPUTE subset of the sandbox surface — what a free-tier payer must not
 * see: core execution (bash/files), the git+gh CLI toolkit, and the PTY shell
 * tools (a shell IS the sandbox). The chat-side session tools
 * (list/spawn/send/read/kill_session) are deliberately NOT here: sessions and
 * chat workers are free on every plan (review #2326) — only the machine is
 * tier-gated — so the TIER filter below must preserve them where the
 * per-agent switch (`filterToolsForSandboxEnablement` above, which strips all
 * three families) would not.
 */
export const SANDBOX_COMPUTE_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...SANDBOX_CORE_TOOL_NAMES,
  ...SANDBOX_GIT_TOOL_NAMES,
  'spawn_shell',
  'send_shell',
  'read_shell',
  'kill_shell',
]);

/**
 * Apply the PAYER-tier gate: an ineligible (free-tier) payer loses the
 * compute tools but keeps the chat-only session orchestration family —
 * showing bash/git/shell tools that hard-fail `tier_ineligible` is the UX
 * bug this prevents, while removing `spawn_session` and friends would gate
 * the free session surface this release explicitly opens (review #2326).
 */
export function filterToolsForSandboxTier<T>(
  tools: Record<string, T>,
  tierEligible: boolean
): Record<string, T> {
  if (tierEligible) return tools;
  return Object.fromEntries(
    Object.entries(tools).filter(([name]) => !SANDBOX_COMPUTE_TOOL_NAMES.has(name))
  );
}

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
 * Apply a page's saved per-agent tool allowlist (`page.enabledTools`).
 *
 * null = unconfigured page, no restriction; [] = every listed PageSpace tool
 * blocked. The session/shell family gets NO exemption: it is part of the
 * sandbox tool group like bash/git, and an operator who restricted an agent's
 * tools restricted these too — the old exemption existed only because the
 * family used to be registered by machine binding, outside the allowlist's
 * sight.
 */
export function filterToolsForAgentAllowlist<T>(
  tools: Record<string, T>,
  allowlist: string[] | null
): Record<string, T> {
  if (allowlist == null) return tools;
  return Object.fromEntries(
    Object.entries(tools).filter(([name]) => allowlist.includes(name))
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

