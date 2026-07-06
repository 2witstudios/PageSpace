import React, { memo, useMemo } from 'react';

import {
  Tool,
  ToolContent,
  ToolHeader,
} from '@/components/ai/ui/tool';
import { PageAgentConversationRenderer } from '@/components/ai/page-agents';
import { TaskRenderer } from './TaskRenderer';
import { TASK_TOOL_NAMES } from '../useAggregatedTasks';
import { renderToolContent } from './registry';
import { dispatchToolCall, resolveIntegrationToolLabel } from './tool-call-dispatch';

export interface ToolPart {
  type: string;
  toolName?: string;
  toolCallId?: string;
  state?: 'input-streaming' | 'input-available' | 'output-available' | 'output-error' | 'done' | 'streaming';
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

interface ToolCallRendererProps {
  part: ToolPart;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

// Helper for safe JSON parsing
const safeJsonParse = (value: unknown): Record<string, unknown> | null => {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return { raw: value };
    }
  }
  if (typeof value === 'object' && value !== null) {
    return value as Record<string, unknown>;
  }
  return null;
};

// Tool name mapping (display labels for the collapsible header)
export const TOOL_NAME_MAP: Record<string, string> = {
  // Drive tools
  'list_drives': 'Workspaces',
  'create_drive': 'Create Workspace',
  'rename_drive': 'Rename Workspace',
  'update_drive_context': 'Update Context',
  'set_home_page': 'Set Home Page',
  // Member tools
  'list_drive_members': 'Members',
  'list_collaborators': 'Collaborators',
  // Role management tools
  'list_drive_roles': 'Roles',
  'get_drive_role': 'Role',
  'create_drive_role': 'Create Role',
  'update_drive_role': 'Update Role',
  'delete_drive_role': 'Delete Role',
  'set_role_page_permissions': 'Set Role Page Access',
  'set_role_drive_wide_permissions': 'Set Role Drive Access',
  'remove_role_page_permissions': 'Remove Role Page Access',
  // Page read tools
  'list_pages': 'Pages',
  'read_page': 'Read Page',
  'list_trash': 'Trash',
  'list_conversations': 'Conversations',
  'read_conversation': 'Conversation',
  'send_channel_message': 'Send Message',
  'delete_channel_message': 'Delete Message',
  // Page write tools
  'replace_lines': 'Edit Document',
  'insert_content': 'Insert Content',
  'create_page': 'Create Page',
  'rename_page': 'Rename Page',
  'trash_page': 'Move to Trash',
  'trash_drive': 'Move Drive to Trash',
  'restore_page': 'Restore',
  'restore_drive': 'Restore Drive',
  'move_page': 'Move Page',
  'edit_sheet_cells': 'Edit Sheet',
  // Search tools
  'regex_search': 'Search',
  'glob_search': 'Find Pages',
  'multi_drive_search': 'Search All',
  // Task tools
  'update_task': 'Update Task',
  'create_task': 'Create Task',
  'delete_task': 'Delete Task',
  'reorder_task': 'Reorder Task',
  'get_assigned_tasks': 'Assigned Tasks',
  'create_task_status': 'Create Status',
  // Agent tools
  'update_agent_config': 'Configure Agent',
  'list_agents': 'Agents',
  'multi_drive_list_agents': 'All Agents',
  'ask_agent': 'Ask Agent',
  // Web
  'web_search': 'Web Search',
  'web_fetch': 'Fetch Page',
  // Activity
  'get_activity': 'Activity',
  // Calendar tools
  'list_calendar_events': 'Calendar',
  'get_calendar_event': 'Event',
  'check_calendar_availability': 'Availability',
  'create_calendar_event': 'Create Event',
  'update_calendar_event': 'Update Event',
  'delete_calendar_event': 'Delete Event',
  'rsvp_calendar_event': 'RSVP',
  'invite_calendar_attendees': 'Invite Attendees',
  'remove_calendar_attendee': 'Remove Attendee',
  // Workflow tools
  'create_workflow': 'Create Workflow',
  'list_workflows': 'Workflows',
  'update_workflow': 'Update Workflow',
  'delete_workflow': 'Delete Workflow',
};

/**
 * Fallback body shown when the tool renderer registry has nothing rich for
 * this tool — shared by ToolCallRendererInternal and ToolRunGroup's
 * length-1 (solo) branch so the two never drift.
 */
export function renderToolFallbackContent(state: string): React.ReactNode {
  return (
    <div className="px-3 py-2 text-sm text-muted-foreground">
      {state === 'input-streaming' || state === 'streaming' ? (
        'Processing...'
      ) : state === 'input-available' ? (
        'Waiting for result...'
      ) : (
        'Completed'
      )}
    </div>
  );
}

/**
 * Computes everything ToolCallRendererInternal needs to render a tool
 * call's title/state/content, extracted so ToolRunGroup can render a
 * length-1 run identically to a standalone card without duplicating this
 * logic.
 */
export function useToolCallDisplay(part: ToolPart, toolName: string) {
  const state = part.state || 'input-available';
  const input = part.input;
  const output = part.output;
  const error = part.errorText;

  // Map state to ToolHeader valid states
  const toolState = useMemo((): "input-streaming" | "input-available" | "output-available" | "output-error" => {
    switch (state) {
      case 'input-streaming': return 'input-streaming';
      case 'input-available': return 'input-available';
      case 'output-available': return 'output-available';
      case 'output-error': return 'output-error';
      case 'done': return 'output-available';
      case 'streaming': return 'input-streaming';
      default: return 'input-available';
    }
  }, [state]);

  // Memoize parsed input/output using consistent parsing
  const parsedInput = useMemo(() => safeJsonParse(input), [input]);
  const parsedOutput = useMemo(() => {
    // Use strict null/undefined check to preserve valid falsy values (0, false, "")
    if (output == null) return null;
    return safeJsonParse(output);
  }, [output]);

  // Memoize formatted tool name
  const formattedToolName = useMemo(() => {
    return (
      resolveIntegrationToolLabel(toolName) ||
      TOOL_NAME_MAP[toolName] ||
      toolName.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
    );
  }, [toolName]);

  // Memoize descriptive title
  const descriptiveTitle = useMemo(() => {
    if (!parsedInput) return formattedToolName;
    const params = parsedInput as Record<string, unknown>;

    // Add context to title based on tool type
    if (params.title && typeof params.title === 'string') {
      return `${formattedToolName}: ${params.title}`;
    }
    if (params.name && typeof params.name === 'string') {
      return `${formattedToolName}: ${params.name}`;
    }
    if (params.query && typeof params.query === 'string') {
      const truncated = params.query.length > 30 ? params.query.slice(0, 30) + '...' : params.query;
      return `${formattedToolName}: ${truncated}`;
    }
    if (params.pattern && typeof params.pattern === 'string') {
      return `${formattedToolName}: ${params.pattern}`;
    }
    if (params.driveSlug && typeof params.driveSlug === 'string') {
      return `${formattedToolName}: ${params.driveSlug}`;
    }
    if (params.owner && params.repo && typeof params.owner === 'string' && typeof params.repo === 'string') {
      const suffix = params.path && typeof params.path === 'string' ? `/${params.path}` : '';
      return `${formattedToolName}: ${params.owner}/${params.repo}${suffix}`;
    }
    if (params.channel && typeof params.channel === 'string') {
      return `${formattedToolName}: ${params.channel}`;
    }
    if (params.repo && typeof params.repo === 'string') {
      return `${formattedToolName}: ${params.repo}`;
    }

    return formattedToolName;
  }, [parsedInput, formattedToolName]);

  // Build rich content via the tool renderer registry
  const richContent = useMemo(
    () => renderToolContent({ toolName, parsedInput, parsedOutput, output, error }),
    [toolName, parsedInput, parsedOutput, output, error]
  );

  return { state, toolState, descriptiveTitle, richContent };
}

// Internal renderer component with hooks
const ToolCallRendererInternal: React.FC<{ part: ToolPart; toolName: string; open?: boolean; onOpenChange?: (open: boolean) => void }> = memo(function ToolCallRendererInternal({ part, toolName, open, onOpenChange }) {
  const { state, toolState, descriptiveTitle, richContent } = useToolCallDisplay(part, toolName);

  // Render with rich content (no Parameters/Result wrappers)
  // Only pass open/onOpenChange (making the Collapsible controlled) when a
  // caller actually provides onOpenChange — otherwise Radix's
  // useControllableState would see `open` flip from undefined to a boolean
  // the first time an ancestor records a manual toggle, logging an
  // uncontrolled-to-controlled warning even though nothing is visibly wrong.
  // Deciding controlled-ness once, up front, based on onOpenChange's
  // presence (rather than open's value) means a given mounted instance never
  // changes modes across its lifetime.
  const collapsibleProps = onOpenChange ? { open: open ?? false, onOpenChange } : {};

  return (
    <Tool className="my-2" {...collapsibleProps}>
      <ToolHeader
        title={descriptiveTitle}
        type={`tool-${toolName}`}
        state={toolState}
      />
      <ToolContent>
        {richContent || renderToolFallbackContent(state)}
      </ToolContent>
    </Tool>
  );
});

export const ToolCallRenderer: React.FC<ToolCallRendererProps> = memo(function ToolCallRenderer({ part, open, onOpenChange }) {
  const dispatch = dispatchToolCall(part, TASK_TOOL_NAMES);

  switch (dispatch.kind) {
    case 'hidden':
      return null;
    case 'task':
      return <TaskRenderer part={dispatch.part} />;
    case 'agent':
      return <PageAgentConversationRenderer part={dispatch.part} />;
    case 'generic':
      return <ToolCallRendererInternal part={dispatch.part} toolName={dispatch.toolName} open={open} onOpenChange={onOpenChange} />;
  }
});
