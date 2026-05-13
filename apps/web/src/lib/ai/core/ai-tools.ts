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
import { CORE_TOOL_NAMES } from './stub-tools';

export const pageSpaceTools = {
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
};

export type PageSpaceTools = typeof pageSpaceTools;

export const corePageSpaceTools = Object.fromEntries(
  Object.entries(pageSpaceTools).filter(([name]) => CORE_TOOL_NAMES.has(name))
);
