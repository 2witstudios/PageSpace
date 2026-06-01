/**
 * Validates that pageSpaceTools correctly aggregates all tool modules.
 * Changes here indicate tools were added/removed/renamed.
 */
import { describe, it, expect, vi } from 'vitest';

// Mock all tool modules to avoid database dependencies
vi.mock('../../tools/drive-tools', () => ({
  driveTools: {
    list_drives: { name: 'list_drives', description: 'List drives' },
    create_drive: { name: 'create_drive', description: 'Create drive' },
    rename_drive: { name: 'rename_drive', description: 'Rename drive' },
  },
}));

vi.mock('../../tools/page-read-tools', () => ({
  pageReadTools: {
    list_pages: { name: 'list_pages', description: 'List pages' },
    read_page: { name: 'read_page', description: 'Read page' },
    list_trash: { name: 'list_trash', description: 'List trash' },
  },
}));

vi.mock('../../tools/page-write-tools', () => ({
  pageWriteTools: {
    replace_lines: { name: 'replace_lines', description: 'Replace lines' },
    create_page: { name: 'create_page', description: 'Create page' },
    rename_page: { name: 'rename_page', description: 'Rename page' },
    trash_page: { name: 'trash_page', description: 'Trash page' },
    trash_drive: { name: 'trash_drive', description: 'Trash drive' },
    restore_page: { name: 'restore_page', description: 'Restore page' },
    restore_drive: { name: 'restore_drive', description: 'Restore drive' },
    move_page: { name: 'move_page', description: 'Move page' },
    edit_sheet_cells: { name: 'edit_sheet_cells', description: 'Edit sheet cells' },
  },
}));

vi.mock('../../tools/search-tools', () => ({
  searchTools: {
    regex_search: { name: 'regex_search', description: 'Regex search' },
    glob_search: { name: 'glob_search', description: 'Glob search' },
    multi_drive_search: { name: 'multi_drive_search', description: 'Multi drive search' },
  },
}));

vi.mock('../../tools/task-management-tools', () => ({
  taskManagementTools: {
    update_task: { name: 'update_task', description: 'Update task' },
    create_task: { name: 'create_task', description: 'Create task' },
    delete_task: { name: 'delete_task', description: 'Delete task' },
    reorder_task: { name: 'reorder_task', description: 'Reorder task' },
  },
}));

vi.mock('../../tools/agent-tools', () => ({
  agentTools: {
    update_agent_config: { name: 'update_agent_config', description: 'Update agent config' },
  },
}));

vi.mock('../../tools/agent-communication-tools', () => ({
  agentCommunicationTools: {
    list_agents: { name: 'list_agents', description: 'List agents' },
    multi_drive_list_agents: { name: 'multi_drive_list_agents', description: 'Multi drive list agents' },
    ask_agent: { name: 'ask_agent', description: 'Ask agent' },
  },
}));

vi.mock('../../tools/web-search-tools', () => ({
  webSearchTools: {
    web_search: { name: 'web_search', description: 'Web search' },
  },
}));

vi.mock('../../tools/activity-tools', () => ({
  activityTools: {
    get_activity: { name: 'get_activity', description: 'Get activity' },
  },
}));

vi.mock('../../tools/calendar-read-tools', () => ({
  calendarReadTools: {
    list_calendar_events: { name: 'list_calendar_events', description: 'List calendar events' },
    get_calendar_event: { name: 'get_calendar_event', description: 'Get calendar event' },
    check_calendar_availability: { name: 'check_calendar_availability', description: 'Check calendar availability' },
  },
}));

vi.mock('../../tools/calendar-write-tools', () => ({
  calendarWriteTools: {
    create_calendar_event: { name: 'create_calendar_event', description: 'Create calendar event' },
    update_calendar_event: { name: 'update_calendar_event', description: 'Update calendar event' },
    delete_calendar_event: { name: 'delete_calendar_event', description: 'Delete calendar event' },
    rsvp_calendar_event: { name: 'rsvp_calendar_event', description: 'RSVP to calendar event' },
    invite_calendar_attendees: { name: 'invite_calendar_attendees', description: 'Invite attendees' },
    remove_calendar_attendee: { name: 'remove_calendar_attendee', description: 'Remove attendee' },
  },
}));

vi.mock('../../tools/channel-tools', () => ({
  channelTools: {
    send_channel_message: { name: 'send_channel_message', description: 'Send channel message' },
  },
}));

vi.mock('../../tools/workflow-tools', () => ({
  workflowTools: {
    create_workflow: { name: 'create_workflow', description: 'Create workflow' },
    list_workflows: { name: 'list_workflows', description: 'List workflows' },
    update_workflow: { name: 'update_workflow', description: 'Update workflow' },
    delete_workflow: { name: 'delete_workflow', description: 'Delete workflow' },
  },
}));

vi.mock('../../tools/member-tools', () => ({
  memberTools: {
    list_drive_members: { name: 'list_drive_members', description: 'List drive members' },
    list_collaborators: { name: 'list_collaborators', description: 'List collaborators' },
  },
}));

// Stub the sandbox tools so the builder can be exercised without loading the DB
// module graph or the real Vercel client.
vi.mock('../../tools/sandbox-tools', () => ({
  buildSandboxTools: () => ({
    bash: { name: 'bash', description: 'Run a shell command' },
    writeFile: { name: 'writeFile', description: 'Write a file' },
    readFile: { name: 'readFile', description: 'Read a file' },
  }),
}));

import { pageSpaceTools, corePageSpaceTools, buildPageSpaceTools } from '../ai-tools';
import { CORE_TOOL_NAMES } from '../stub-tools';
import { memberTools } from '../../tools/member-tools';
import { driveTools } from '../../tools/drive-tools';
import { pageReadTools } from '../../tools/page-read-tools';
import { pageWriteTools } from '../../tools/page-write-tools';
import { searchTools } from '../../tools/search-tools';
import { taskManagementTools } from '../../tools/task-management-tools';
import { agentTools } from '../../tools/agent-tools';
import { agentCommunicationTools } from '../../tools/agent-communication-tools';
import { webSearchTools } from '../../tools/web-search-tools';
import { activityTools } from '../../tools/activity-tools';
import { calendarReadTools } from '../../tools/calendar-read-tools';
import { calendarWriteTools } from '../../tools/calendar-write-tools';
import { channelTools } from '../../tools/channel-tools';
import { workflowTools } from '../../tools/workflow-tools';

describe('ai-tools', () => {
  describe('pageSpaceTools aggregation', () => {
    it('does not expose the removed GitHub import tool', () => {
      expect(pageSpaceTools).not.toHaveProperty('import_from_github');
    });

    it('equals the merged object of all tool modules', () => {
      expect(pageSpaceTools).toEqual({
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
      });
    });

    it('has no key collisions between tool modules', () => {
      const moduleKeysets = [
        Object.keys(memberTools),
        Object.keys(driveTools),
        Object.keys(pageReadTools),
        Object.keys(pageWriteTools),
        Object.keys(searchTools),
        Object.keys(taskManagementTools),
        Object.keys(agentTools),
        Object.keys(agentCommunicationTools),
        Object.keys(webSearchTools),
        Object.keys(activityTools),
        Object.keys(calendarReadTools),
        Object.keys(calendarWriteTools),
        Object.keys(channelTools),
        Object.keys(workflowTools),
      ];

      const allKeys = moduleKeysets.flat();
      const uniqueKeys = new Set(allKeys);

      // If there are duplicates, find them for a helpful error message
      if (uniqueKeys.size !== allKeys.length) {
        const seen = new Set<string>();
        const duplicates: string[] = [];
        for (const key of allKeys) {
          if (seen.has(key)) {
            duplicates.push(key);
          }
          seen.add(key);
        }
        throw new Error(`Tool name collisions detected: ${duplicates.join(', ')}`);
      }

      expect(uniqueKeys.size).toBe(allKeys.length);
    });

    it('has no undefined or null tools', () => {
      for (const [name, tool] of Object.entries(pageSpaceTools)) {
        if (tool === undefined || tool === null) {
          throw new Error(`Tool "${name}" is ${tool}`);
        }
      }
    });

    it('omits the code-execution tools by default (flag off)', () => {
      expect(pageSpaceTools).not.toHaveProperty('bash');
      expect(pageSpaceTools).not.toHaveProperty('writeFile');
      expect(pageSpaceTools).not.toHaveProperty('readFile');
    });
  });

  describe('buildPageSpaceTools code-execution gating', () => {
    it('given the flag disabled, should not register bash/writeFile/readFile or call the factory', () => {
      let built = false;
      const tools = buildPageSpaceTools({
        codeExecutionEnabled: false,
        sandboxToolsFactory: () => {
          built = true;
          return { bash: {}, writeFile: {}, readFile: {} } as never;
        },
      });
      expect(tools).not.toHaveProperty('bash');
      expect(tools).not.toHaveProperty('writeFile');
      expect(tools).not.toHaveProperty('readFile');
      expect(built).toBe(false);
    });

    it('given the flag enabled, should register bash/writeFile/readFile alongside the base tools', () => {
      const tools = buildPageSpaceTools({
        codeExecutionEnabled: true,
        sandboxToolsFactory: () =>
          ({
            bash: { name: 'bash' },
            writeFile: { name: 'writeFile' },
            readFile: { name: 'readFile' },
          }) as never,
      });
      expect(tools).toHaveProperty('bash');
      expect(tools).toHaveProperty('writeFile');
      expect(tools).toHaveProperty('readFile');
      // Base tools remain present.
      expect(tools).toHaveProperty('list_drives');
    });
  });

  describe('corePageSpaceTools', () => {
    it('is exported and defined', () => {
      expect(corePageSpaceTools).toBeDefined();
    });

    it('contains only tools in CORE_TOOL_NAMES', () => {
      const keys = Object.keys(corePageSpaceTools);
      for (const key of keys) {
        expect(CORE_TOOL_NAMES.has(key)).toBe(true);
      }
    });

    it('contains all CORE_TOOL_NAMES tools that exist in pageSpaceTools', () => {
      for (const name of CORE_TOOL_NAMES) {
        if (name in pageSpaceTools) {
          expect(corePageSpaceTools).toHaveProperty(name);
        }
      }
    });

    it('core tool objects are the same references as in pageSpaceTools', () => {
      for (const [name, tool] of Object.entries(corePageSpaceTools)) {
        expect(tool).toBe(pageSpaceTools[name as keyof typeof pageSpaceTools]);
      }
    });
  });
});
