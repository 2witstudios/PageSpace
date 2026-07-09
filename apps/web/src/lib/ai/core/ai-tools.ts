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
import { buildSandboxTools } from '../tools/sandbox-tools-runtime';
import { buildGitSandboxTools } from '../tools/sandbox-git-tools-runtime';
import { CORE_TOOL_NAMES } from './stub-tools';

const baseTools = {
  ...memberTools,
  ...roleManagementTools,
  ...driveTools,
  ...pageReadTools,
  ...pageWriteTools,
  ...searchTools,
  ...taskManagementTools,
  ...agentTools,
  ...agentCommunicationTools,
  ...webSearchTools,
  ...activityTools,
  ...calendarReadTools,
  ...calendarWriteTools,
  ...channelTools,
  ...workflowTools,
  ...triggerTools,
  ...modelTools,
  ...commandTools,
  ...formTools,
};

/**
 * Categorized enumeration of every workspace tool, keyed by domain. Each category
 * reads the keys of the same module object spread into `baseTools` above.
 *
 * This is a parallel structure rather than a derivation because `baseTools` keeps
 * an explicit spread to preserve its precise per-tool type (`PageSpaceTools`), and
 * category grouping is lost once the modules are flattened. The two lists can't
 * silently drift: `tool-registry-docs.test.ts` asserts the union of all categories
 * equals `WORKSPACE_TOOL_NAMES`, so adding a module to one without the other fails CI.
 *
 * Code-execution tools (`bash`/git/etc.) are intentionally excluded — they are
 * flag-gated behind `CODE_EXECUTION_ENABLED` (default OFF) and are not part of the
 * public workspace-tool count.
 */
export const TOOL_REGISTRY = {
  members: Object.keys(memberTools),
  roles: Object.keys(roleManagementTools),
  drives: Object.keys(driveTools),
  pagesRead: Object.keys(pageReadTools),
  pagesWrite: Object.keys(pageWriteTools),
  search: Object.keys(searchTools),
  tasks: Object.keys(taskManagementTools),
  agents: Object.keys(agentTools),
  agentCommunication: Object.keys(agentCommunicationTools),
  web: Object.keys(webSearchTools),
  activity: Object.keys(activityTools),
  calendarRead: Object.keys(calendarReadTools),
  calendarWrite: Object.keys(calendarWriteTools),
  channels: Object.keys(channelTools),
  workflows: Object.keys(workflowTools),
  triggers: Object.keys(triggerTools),
  models: Object.keys(modelTools),
  commands: Object.keys(commandTools),
  forms: Object.keys(formTools),
} as const;

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
