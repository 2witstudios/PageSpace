import type { Tool } from 'ai';
import { isCodeExecutionEnabled } from '@pagespace/lib/services/sandbox/can-run-code';
import { memberTools } from '../tools/member-tools';
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
import { modelTools } from '../tools/model-tools';
import { buildSandboxTools } from '../tools/sandbox-tools-runtime';
import { CORE_TOOL_NAMES } from './stub-tools';

const baseTools = {
  ...memberTools,
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
  ...modelTools,
};

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
}: {
  codeExecutionEnabled?: boolean;
  sandboxToolsFactory?: () => Record<string, Tool>;
} = {}) {
  if (!codeExecutionEnabled) return { ...baseTools };
  return { ...baseTools, ...sandboxToolsFactory() };
}

export const pageSpaceTools = buildPageSpaceTools();

export type PageSpaceTools = typeof pageSpaceTools;

export const corePageSpaceTools = Object.fromEntries(
  Object.entries(pageSpaceTools).filter(([name]) => CORE_TOOL_NAMES.has(name))
);
