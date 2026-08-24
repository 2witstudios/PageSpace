import type { Tool } from 'ai';
import { isCodeExecutionEnabled } from '@pagespace/lib/services/sandbox/can-run-code';
import { memberTools } from '../tools/member-tools';
import { roleManagementTools } from '../tools/role-management-tools';
import { driveTools } from '../tools/drive-tools';
import { pageReadTools } from '../tools/page-read-tools';
import { pageWriteTools } from '../tools/page-write-tools';
import { sheetReadTools } from '../tools/sheet-read-tools';
import { searchTools } from '../tools/search-tools';
import { taskManagementTools } from '../tools/task-management-tools';
import { agentTools } from '../tools/agent-tools';
import { agentCommunicationTools } from '../tools/agent-communication-tools';
import { webSearchTools } from '../tools/web-search-tools';
import { activityTools } from '../tools/activity-tools';
import { calendarReadTools } from '../tools/calendar-read-tools';
import { calendarWriteTools } from '../tools/calendar-write-tools';
import { channelTools } from '../tools/channel-tools';
import { workflowTools } from '../tools/workflow-tools';
import { triggerTools } from '../tools/trigger-tools';
import { modelTools } from '../tools/model-tools';
import { commandTools } from '../tools/command-tools';
import { skillTools } from '../tools/skill-tools';
import { formTools } from '../tools/form-tools';
import { imageGenerationTools } from '../tools/image-generation-tools';
import { pagePaneTools } from '../tools/page-pane-tools-runtime';
import { planTools } from '../tools/plan-tools';
import { buildSandboxTools } from '../tools/sandbox-tools-runtime';
import { buildGitSandboxTools } from '../tools/sandbox-git-tools-runtime';
import { buildSessionTools } from '../tools/session-tools-runtime';
import { SANDBOX_COMPUTE_TOOL_NAMES } from './tool-filtering';
import { CORE_TOOL_NAMES } from './stub-tools';

/**
 * The canonical map of workspace tool modules, keyed by domain category. This is the
 * SINGLE source of truth for the agent tool set: both the flat `baseTools` registry
 * and the categorized `TOOL_REGISTRY` are derived from it, so adding a tool module is
 * a one-line edit here — the flat registry, the category map, and the doc-enforced
 * `WORKSPACE_TOOL_COUNT` all update together.
 *
 * The sandbox-family tools are intentionally NOT here — the compute tools
 * (`bash`/git/shells) are flag-gated behind `CODE_EXECUTION_ENABLED` (default
 * OFF, see `buildPageSpaceTools`), the chat-only session tools are factory-built
 * alongside them, and neither group is part of the public workspace-tool count.
 */
const TOOL_MODULES = {
  members: memberTools,
  roles: roleManagementTools,
  drives: driveTools,
  pagesRead: pageReadTools,
  pagesWrite: pageWriteTools,
  sheetsRead: sheetReadTools,
  search: searchTools,
  tasks: taskManagementTools,
  agents: agentTools,
  agentCommunication: agentCommunicationTools,
  web: webSearchTools,
  activity: activityTools,
  calendarRead: calendarReadTools,
  calendarWrite: calendarWriteTools,
  channels: channelTools,
  workflows: workflowTools,
  triggers: triggerTools,
  models: modelTools,
  commands: commandTools,
  skills: skillTools,
  forms: formTools,
  imageGeneration: imageGenerationTools,
  pagePane: pagePaneTools,
  plan: planTools,
} as const;

// Flatten the module map into one ToolSet. No key collisions across modules — the
// `ai-tools.test.ts` "no key collisions" case guards that.
const baseTools = Object.assign(
  {},
  ...Object.values(TOOL_MODULES),
) as Record<string, Tool>;

/**
 * Categorized enumeration of every workspace tool, keyed by domain — a projection of
 * `TOOL_MODULES`. Gives agent-facing docs and lints a programmatic source for what
 * tools exist and which category each belongs to (issue #1055).
 */
type ToolCategory = keyof typeof TOOL_MODULES;
export const TOOL_REGISTRY: Record<ToolCategory, readonly string[]> = (
  Object.keys(TOOL_MODULES) as ToolCategory[]
).reduce(
  (acc, category) => {
    acc[category] = Object.keys(TOOL_MODULES[category]);
    return acc;
  },
  {} as Record<ToolCategory, readonly string[]>,
);

/** Flat list of every workspace tool available to a default cloud agent. */
export const WORKSPACE_TOOL_NAMES: readonly string[] = Object.keys(baseTools);

/**
 * Canonical public count of workspace tools (base registry; code-exec excluded).
 * This is THE number that marketing/README copy must cite — enforced by
 * `core/__tests__/tool-registry-docs.test.ts`.
 */
export const WORKSPACE_TOOL_COUNT = WORKSPACE_TOOL_NAMES.length;

/**
 * Assemble the agent tool registry, registering the COMPUTE tools
 * (`bash` / `writeFile` / `readFile`, the git/gh CLI toolkit, and the PTY
 * shell family) ONLY when the global kill-switch is on.
 *
 * Code execution is the highest-risk surface in the product, so it ships
 * default-OFF: with `CODE_EXECUTION_ENABLED` unset (the default), the compute
 * tools are never added to the registry, never discoverable via `tool_search`,
 * and never reachable by a model. Staged rollout rides this env kill-switch
 * plus the per-call `canRunCode` authz, not a separate flag table — there is
 * none. The sandbox factory is injected and the Fly Sprites driver is
 * dynamically imported only when a tool runs, so the off-path never constructs
 * the client nor loads the Node-24/ESM-only `@fly/sprites` SDK, and both
 * branches are unit tested without real IO.
 *
 * The CHAT-ONLY session family (list/spawn/send/read/kill_session) registers
 * on BOTH branches: those tools are conversation orchestration through the
 * standard chat pipeline — part of the free session surface this route family
 * opens to everyone (`/api/agent-workspaces` route docs) — and never touch the
 * sandbox, so gating them on the kill-switch hid a chat capability behind a
 * compute flag (review #2326). The split is `SANDBOX_COMPUTE_TOOL_NAMES`, the
 * same source of truth the payer-tier filter uses.
 */
export function buildPageSpaceTools({
  codeExecutionEnabled = isCodeExecutionEnabled(),
  sandboxToolsFactory = buildSandboxTools,
  sandboxGitToolsFactory = buildGitSandboxTools,
  sessionToolsFactory = buildSessionTools,
}: {
  codeExecutionEnabled?: boolean;
  sandboxToolsFactory?: () => Record<string, Tool>;
  sandboxGitToolsFactory?: () => Record<string, Tool>;
  sessionToolsFactory?: () => Record<string, Tool>;
} = {}) {
  const sessionTools = sessionToolsFactory();
  if (!codeExecutionEnabled) {
    const chatOnlySessionTools = Object.fromEntries(
      Object.entries(sessionTools).filter(([name]) => !SANDBOX_COMPUTE_TOOL_NAMES.has(name)),
    );
    return { ...baseTools, ...chatOnlySessionTools };
  }
  return { ...baseTools, ...sandboxToolsFactory(), ...sandboxGitToolsFactory(), ...sessionTools };
}

export const pageSpaceTools = buildPageSpaceTools();

export const corePageSpaceTools = Object.fromEntries(
  Object.entries(pageSpaceTools).filter(([name]) => CORE_TOOL_NAMES.has(name))
);
