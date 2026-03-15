import { describe, it, expect, vi } from 'vitest';

// Mock all tool modules to avoid database dependencies
vi.mock('../../tools/drive-tools', () => ({ driveTools: { list_drives: { description: 'List drives', inputSchema: {} } } }));
vi.mock('../../tools/page-read-tools', () => ({ pageReadTools: { read_page: { description: 'Read page', inputSchema: {} }, list_pages: { description: 'List pages', inputSchema: {} }, list_trash: { description: 'List trash', inputSchema: {} } } }));
vi.mock('../../tools/page-write-tools', () => ({ pageWriteTools: { create_page: { description: 'Create page', inputSchema: {} }, rename_page: { description: 'Rename page', inputSchema: {} }, replace_lines: { description: 'Replace lines', inputSchema: {} }, trash: { description: 'Trash', inputSchema: {} }, restore: { description: 'Restore', inputSchema: {} }, move_page: { description: 'Move page', inputSchema: {} }, edit_sheet_cells: { description: 'Edit sheet cells', inputSchema: {} } } }));
vi.mock('../../tools/search-tools', () => ({ searchTools: { regex_search: { description: 'Regex search', inputSchema: {} }, glob_search: { description: 'Glob search', inputSchema: {} }, multi_drive_search: { description: 'Multi drive search', inputSchema: {} } } }));
vi.mock('../../tools/task-management-tools', () => ({ taskManagementTools: { update_task: { description: 'Update task', inputSchema: {} } } }));
vi.mock('../../tools/agent-tools', () => ({ agentTools: { update_agent_config: { description: 'Update agent config', inputSchema: {} } } }));
vi.mock('../../tools/agent-communication-tools', () => ({ agentCommunicationTools: { list_agents: { description: 'List agents', inputSchema: {} }, multi_drive_list_agents: { description: 'Multi drive list agents', inputSchema: {} }, ask_agent: { description: 'Ask agent', inputSchema: {} } } }));
vi.mock('../../tools/web-search-tools', () => ({ webSearchTools: { web_search: { description: 'Web search', inputSchema: {} } } }));
vi.mock('../../tools/activity-tools', () => ({ activityTools: { get_activity: { description: 'Get activity', inputSchema: {} } } }));
vi.mock('../../tools/calendar-read-tools', () => ({ calendarReadTools: { list_calendar_events: { description: 'List calendar events', inputSchema: {} }, get_calendar_event: { description: 'Get calendar event', inputSchema: {} }, check_calendar_availability: { description: 'Check calendar availability', inputSchema: {} } } }));
vi.mock('../../tools/calendar-write-tools', () => ({ calendarWriteTools: { create_calendar_event: { description: 'Create calendar event', inputSchema: {} }, update_calendar_event: { description: 'Update calendar event', inputSchema: {} }, delete_calendar_event: { description: 'Delete calendar event', inputSchema: {} }, rsvp_calendar_event: { description: 'RSVP', inputSchema: {} }, invite_calendar_attendees: { description: 'Invite', inputSchema: {} }, remove_calendar_attendee: { description: 'Remove attendee', inputSchema: {} } } }));
vi.mock('../../tools/channel-tools', () => ({ channelTools: { send_channel_message: { description: 'Send channel message', inputSchema: {} } } }));

// Mock @pagespace/lib/ai-context-calculator
vi.mock('@pagespace/lib/ai-context-calculator', () => ({
  estimateSystemPromptTokens: vi.fn((text: string) => Math.ceil(text.length / 4)),
}));

// Mock @pagespace/lib/server for mention-processor
vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    ai: {
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      child: vi.fn().mockReturnThis(),
    },
  },
}));

import {
  buildCompleteRequest,
  buildBothModePayloads,
} from '../complete-request-builder';

import type { LocationContext } from '../complete-request-builder';

describe('complete-request-builder', () => {
  describe('buildCompleteRequest', () => {
    it('should build a dashboard context request', () => {
      const result = buildCompleteRequest({
        contextType: 'dashboard',
      });

      expect(result).toHaveProperty('request');
      expect(result).toHaveProperty('formattedString');
      expect(result).toHaveProperty('tokenEstimates');
      expect(result).toHaveProperty('toolsSummary');
    });

    it('should include system prompt in request', () => {
      const result = buildCompleteRequest({
        contextType: 'dashboard',
      });

      expect(result.request.system).toBeTruthy();
      expect(result.request.system).toContain('PAGESPACE AI');
    });

    it('should use default model when not provided', () => {
      const result = buildCompleteRequest({
        contextType: 'dashboard',
      });

      expect(result.request.model).toBe('openrouter/anthropic/claude-sonnet-4');
    });

    it('should use custom model when provided', () => {
      const result = buildCompleteRequest({
        contextType: 'dashboard',
        model: 'gpt-4o',
      });

      expect(result.request.model).toBe('gpt-4o');
    });

    it('should include tools in request', () => {
      const result = buildCompleteRequest({
        contextType: 'dashboard',
      });

      expect(Array.isArray(result.request.tools)).toBe(true);
      expect(result.request.tools.length).toBeGreaterThan(0);
    });

    it('should exclude write tools in read-only mode', () => {
      const fullResult = buildCompleteRequest({ contextType: 'dashboard', isReadOnly: false });
      const readOnlyResult = buildCompleteRequest({ contextType: 'dashboard', isReadOnly: true });

      expect(fullResult.request.tools.length).toBeGreaterThan(readOnlyResult.request.tools.length);
    });

    it('should include example message by default', () => {
      const result = buildCompleteRequest({
        contextType: 'dashboard',
        includeExampleMessage: true,
      });

      expect(result.request.messages).toHaveLength(1);
      expect(result.request.messages[0].role).toBe('user');
    });

    it('should not include messages when includeExampleMessage is false', () => {
      const result = buildCompleteRequest({
        contextType: 'dashboard',
        includeExampleMessage: false,
      });

      expect(result.request.messages).toHaveLength(0);
    });

    it('should include experimental context with userId', () => {
      const result = buildCompleteRequest({
        contextType: 'dashboard',
      });

      expect(result.request.experimental_context.userId).toBe('[user-id]');
      expect(result.request.experimental_context.modelCapabilities).toBeDefined();
    });

    it('should build page context with location info', () => {
      const locationContext: LocationContext = {
        currentPage: {
          id: 'page-1',
          title: 'My Page',
          type: 'DOCUMENT',
          path: '/drive/my-page',
          isTaskLinked: false,
        },
        currentDrive: {
          id: 'drive-1',
          name: 'My Drive',
          slug: 'my-drive',
        },
      };

      const result = buildCompleteRequest({
        contextType: 'page',
        locationContext,
      });

      expect(result.request.system).toContain('My Page');
      expect(result.request.system).toContain('DOCUMENT');
    });

    it('should build drive context with location info', () => {
      const locationContext: LocationContext = {
        currentDrive: {
          id: 'drive-1',
          name: 'Work Space',
          slug: 'work-space',
        },
      };

      const result = buildCompleteRequest({
        contextType: 'drive',
        locationContext,
      });

      expect(result.request.system).toContain('Work Space');
    });

    it('should calculate token estimates', () => {
      const result = buildCompleteRequest({
        contextType: 'dashboard',
      });

      expect(result.tokenEstimates.systemPrompt).toBeGreaterThan(0);
      expect(result.tokenEstimates.tools).toBeGreaterThan(0);
      expect(result.tokenEstimates.total).toBe(
        result.tokenEstimates.systemPrompt +
        result.tokenEstimates.tools +
        result.tokenEstimates.experimentalContext
      );
    });

    it('should include toolsSummary with allowed and denied lists', () => {
      const result = buildCompleteRequest({
        contextType: 'dashboard',
      });

      expect(Array.isArray(result.toolsSummary.allowed)).toBe(true);
      expect(Array.isArray(result.toolsSummary.denied)).toBe(true);
    });

    it('should include formattedString with the request details', () => {
      const result = buildCompleteRequest({
        contextType: 'dashboard',
      });

      expect(result.formattedString).toContain('COMPLETE AI REQUEST PAYLOAD');
      expect(result.formattedString).toContain('SYSTEM PROMPT');
      expect(result.formattedString).toContain('TOOLS');
    });

    it('should include read-only mode label in formattedString', () => {
      const result = buildCompleteRequest({
        contextType: 'dashboard',
        isReadOnly: true,
      });

      expect(result.formattedString).toContain('READ-ONLY');
    });

    it('should include full access label when not read-only', () => {
      const result = buildCompleteRequest({
        contextType: 'dashboard',
        isReadOnly: false,
      });

      expect(result.formattedString).toContain('FULL ACCESS');
    });

    it('should use global assistant instructions for non-page context', () => {
      const result = buildCompleteRequest({
        contextType: 'dashboard',
      });

      expect(result.request.system).toContain('WORKSPACE RULES');
    });

    it('should use inline instructions for page context', () => {
      const locationContext: LocationContext = {
        currentPage: {
          id: 'page-1',
          title: 'Test Page',
          type: 'DOCUMENT',
          path: '/drive/test-page',
        },
        currentDrive: {
          id: 'drive-1',
          name: 'Drive',
          slug: 'drive',
        },
      };

      const result = buildCompleteRequest({
        contextType: 'page',
        locationContext,
      });

      expect(result.request.system).toContain('CONTEXT');
    });
  });

  describe('buildBothModePayloads', () => {
    it('should build both full access and read-only payloads', () => {
      const result = buildBothModePayloads('dashboard');

      expect(result).toHaveProperty('fullAccess');
      expect(result).toHaveProperty('readOnly');
    });

    it('should have more tools in full access than read-only', () => {
      const result = buildBothModePayloads('dashboard');

      expect(result.fullAccess.request.tools.length).toBeGreaterThan(
        result.readOnly.request.tools.length
      );
    });

    it('should pass locationContext to both builds', () => {
      const locationContext: LocationContext = {
        currentDrive: {
          id: 'drive-1',
          name: 'Test Drive',
          slug: 'test-drive',
        },
      };

      const result = buildBothModePayloads('drive', locationContext);

      expect(result.fullAccess.request.system).toContain('Test Drive');
      expect(result.readOnly.request.system).toContain('Test Drive');
    });
  });
});
