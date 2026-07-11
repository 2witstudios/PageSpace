import type { Tool } from 'ai';
import { isCodeExecutionEnabled } from '@pagespace/lib/services/sandbox/can-run-code';
import { memberTools } from '../tools/member-tools';
import { roleManagementTools } from '../tools/role-management-tools';
import { driveTools } from '../tools/drive-tools';
import { pageReadTools } from '../tools/page-read-tools';
import { pageWriteTools } from '../tools/page-write-tools';
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
import { formTools } from '../tools/form-tools';
import { imageGenerationTools } from '../tools/image-generation-tools';
import { buildSandboxTools } from '../tools/sandbox-tools-runtime';
import { buildGitSandboxTools } from '../tools/sandbox-git-tools-runtime';
import { CORE_TOOL_NAMES } from './stub-tools';

/**
 * The canonical map of workspace tool modules, keyed by domain category. This is the
 * SINGLE source of truth for the agent tool set: both the flat `baseTools` registry
 * and the categorized `TOOL_REGISTRY` are derived from it, so adding a tool module is
 * a one-line edit here — the flat registry, the category map, and the doc-enforced
 * `WORKSPACE_TOOL_COUNT` all update together.
 *
 * Code-execution tools (`bash`/git/etc.) are intentionally NOT here — they are
 * flag-gated behind `CODE_EXECUTION_ENABLED` (default OFF, see `buildPageSpaceTools`)
 * and are not part of the public workspace-tool count.
 */
const TOOL_MODULES = {
  members: memberTools,
  roles: roleManagementTools,
  drives: driveTools,
  pagesRead: pageReadTools,
  pagesWrite: pageWriteTools,
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
  forms: formTools,
  imageGeneration: imageGenerationTools,
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
 * Assemble the agent tool registry, registering the code-execution tools
 * (`bash` / `writeFile` / `readFile`) ONLY when the global kill-switch is on.
 *
 * Code execution is the highest-risk surface in the product, so it ships
 * default-OFF: with `CODE_EXECUTION_ENABLED` unset (the default), the tools are
 * never added to the registry, never discoverable via `tool_search`, and never
 * reachable by a model. Staged rollout rides this env kill-switch plus the
 * per-call `canRunCode` authz (drive owner/admin), not a separate flag table —
 * there is none. The sandbox factory is injected and the Fly Sprites driver is
 * dynamically imported only when a tool runs, so the off-path never constructs
 * the client nor loads the Node-24/ESM-only `@fly/sprites` SDK, and both
 * branches are unit tested without real IO.
 */
export function buildPageSpaceTools({
  codeExecutionEnabled = isCodeExecutionEnabled(),
  sandboxToolsFactory = buildSandboxTools,
  sandboxGitToolsFactory = buildGitSandboxTools,
}: {
  codeExecutionEnabled?: boolean;
  sandboxToolsFactory?: () => Record<string, Tool>;
  sandboxGitToolsFactory?: () => Record<string, Tool>;
} = {}) {
  if (!codeExecutionEnabled) return { ...baseTools };
  return { ...baseTools, ...sandboxToolsFactory(), ...sandboxGitToolsFactory() };
}

export const pageSpaceTools = buildPageSpaceTools();

export type PageSpaceTools = typeof pageSpaceTools;

export const corePageSpaceTools = Object.fromEntries(
  Object.entries(pageSpaceTools).filter(([name]) => CORE_TOOL_NAMES.has(name))
);
