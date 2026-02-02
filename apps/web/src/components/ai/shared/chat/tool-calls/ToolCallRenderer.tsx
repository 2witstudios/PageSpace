import React, { memo, useMemo } from 'react';

import {
  Tool,
  ToolContent,
  ToolHeader,
} from '@/components/ai/ui/tool';
import { PageAgentConversationRenderer } from '@/components/ai/page-agents';
import { TaskRenderer } from './TaskRenderer';
import { RichContentRenderer } from './RichContentRenderer';
import { RichDiffRenderer } from './RichDiffRenderer';
import { PageTreeRenderer } from './PageTreeRenderer';
import { DriveListRenderer } from './DriveListRenderer';
import { ActionResultRenderer } from './ActionResultRenderer';
import { SearchResultsRenderer } from './SearchResultsRenderer';
import { AgentListRenderer } from './AgentListRenderer';
import { ActivityRenderer } from './ActivityRenderer';
import { WebSearchRenderer } from './WebSearchRenderer';

interface ToolPart {
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

// Tool name mapping
const TOOL_NAME_MAP: Record<string, string> = {
  // Drive tools
  'list_drives': 'Workspaces',
  'create_drive': 'Create Workspace',
  'rename_drive': 'Rename Workspace',
  'update_drive_context': 'Update Context',
  // Page read tools
  'list_pages': 'Pages',
  'read_page': 'Read Page',
  'list_trash': 'Trash',
  'list_conversations': 'Conversations',
  'read_conversation': 'Conversation',
  // Page write tools
  'replace_lines': 'Edit Document',
  'create_page': 'Create Page',
  'rename_page': 'Rename Page',
  'trash': 'Move to Trash',
  'restore': 'Restore',
  'move_page': 'Move Page',
  'edit_sheet_cells': 'Edit Sheet',
  // Search tools
  'regex_search': 'Search',
  'glob_search': 'Find Pages',
  'multi_drive_search': 'Search All',
  // Task tools
  'update_task': 'Update Task',
  'get_assigned_tasks': 'Assigned Tasks',
  // Agent tools
  'update_agent_config': 'Configure Agent',
  'list_agents': 'Agents',
  'multi_drive_list_agents': 'All Agents',
  'ask_agent': 'Ask Agent',
  // Web search
  'web_search': 'Web Search',
  // Activity
  'get_activity': 'Activity',
};

// Internal renderer component with hooks
const ToolCallRendererInternal: React.FC<{ part: ToolPart; toolName: string }> = memo(function ToolCallRendererInternal({ part, toolName }) {
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

  // Memoize parsed input/output
  const parsedInput = useMemo(() => safeJsonParse(input), [input]);
  const parsedOutput = useMemo(() => {
    if (!output) return null;
    try {
      return typeof output === 'string' ? JSON.parse(output) : output;
    } catch {
      return null;
    }
  }, [output]);

  // Memoize formatted tool name
  const formattedToolName = useMemo(() => {
    return TOOL_NAME_MAP[toolName] || toolName.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
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

    return formattedToolName;
  }, [parsedInput, formattedToolName]);

  // Build rich content for all supported tools
  const richContent = useMemo((): React.ReactNode | null => {
    // Handle errors
    if (error) {
      return (
        <ActionResultRenderer
          actionType="update"
          success={false}
          errorMessage={error}
          title={parsedInput?.title as string}
        />
      );
    }

    if (!parsedOutput) return null;

    // === DRIVE TOOLS ===
    if (toolName === 'list_drives' && parsedOutput.drives) {
      return <DriveListRenderer drives={parsedOutput.drives} />;
    }

    if (toolName === 'create_drive' || toolName === 'rename_drive') {
      return (
        <ActionResultRenderer
          actionType={toolName === 'create_drive' ? 'create' : 'rename'}
          success={parsedOutput.success !== false}
          title={parsedOutput.name || parsedOutput.title}
          oldTitle={parsedOutput.oldName}
          message={parsedOutput.message}
          errorMessage={parsedOutput.error}
        />
      );
    }

    if (toolName === 'update_drive_context') {
      return (
        <ActionResultRenderer
          actionType="update"
          success={parsedOutput.success !== false}
          title="Workspace Context"
          message={parsedOutput.message || 'Context updated successfully'}
          errorMessage={parsedOutput.error}
        />
      );
    }

    // === PAGE READ TOOLS ===
    if (toolName === 'list_pages' && parsedOutput.tree) {
      return (
        <PageTreeRenderer
          tree={parsedOutput.tree}
          driveName={parsedOutput.driveName}
          driveId={parsedOutput.driveId}
        />
      );
    }

    if (toolName === 'list_trash' && parsedOutput.tree) {
      return (
        <PageTreeRenderer
          tree={parsedOutput.tree}
          driveName={parsedOutput.driveName}
          driveId={parsedOutput.driveId}
          title="Trash"
        />
      );
    }

    if (toolName === 'read_page' && (parsedOutput.rawContent || parsedOutput.content)) {
      return (
        <RichContentRenderer
          title={parsedOutput.title || 'Document'}
          content={parsedOutput.rawContent || parsedOutput.content}
          pageId={parsedOutput.pageId}
          pageType={parsedOutput.type}
        />
      );
    }

    if (toolName === 'list_conversations' && parsedOutput.conversations) {
      // Display conversations as a simple list
      const conversations = parsedOutput.conversations as Array<{ id: string; title?: string; messageCount?: number }>;
      return (
        <PageTreeRenderer
          tree={conversations.map(c => ({
            path: c.id,
            title: c.title || `Conversation ${c.id.slice(0, 8)}`,
            type: 'AI_CHAT',
            pageId: c.id,
            children: []
          }))}
          title="Conversations"
        />
      );
    }

    if (toolName === 'read_conversation' && parsedOutput.content) {
      return (
        <RichContentRenderer
          title={parsedOutput.title || 'Conversation'}
          content={parsedOutput.content}
          pageId={parsedOutput.pageId}
          pageType="AI_CHAT"
        />
      );
    }

    // === PAGE WRITE TOOLS ===
    if (toolName === 'replace_lines') {
      if (parsedOutput.success && parsedOutput.oldContent && parsedOutput.newContent) {
        return (
          <RichDiffRenderer
            title={parsedOutput.title || 'Document'}
            oldContent={parsedOutput.oldContent}
            newContent={parsedOutput.newContent}
            pageId={parsedOutput.pageId}
            changeSummary={parsedOutput.summary}
          />
        );
      }
      if (parsedOutput.success && parsedOutput.newContent) {
        return (
          <RichContentRenderer
            title={parsedOutput.title || 'Document'}
            content={parsedOutput.newContent}
            pageId={parsedOutput.pageId}
          />
        );
      }
      return (
        <ActionResultRenderer
          actionType="update"
          success={parsedOutput.success !== false}
          title={parsedOutput.title}
          pageId={parsedOutput.pageId}
          pageType={parsedOutput.type}
          errorMessage={parsedOutput.error}
        />
      );
    }

    if (toolName === 'create_page') {
      return (
        <ActionResultRenderer
          actionType="create"
          success={parsedOutput.success !== false}
          title={parsedOutput.title}
          pageId={parsedOutput.pageId}
          driveId={parsedOutput.driveId}
          pageType={parsedOutput.type}
          message={parsedOutput.message}
          errorMessage={parsedOutput.error}
        />
      );
    }

    if (toolName === 'rename_page') {
      return (
        <ActionResultRenderer
          actionType="rename"
          success={parsedOutput.success !== false}
          title={parsedOutput.newTitle || parsedOutput.title}
          oldTitle={parsedOutput.oldTitle}
          pageId={parsedOutput.pageId}
          driveId={parsedOutput.driveId}
          pageType={parsedOutput.type}
          errorMessage={parsedOutput.error}
        />
      );
    }

    if (toolName === 'trash') {
      return (
        <ActionResultRenderer
          actionType="trash"
          success={parsedOutput.success !== false}
          title={parsedOutput.title}
          pageType={parsedOutput.type}
          message={parsedOutput.message}
          errorMessage={parsedOutput.error}
        />
      );
    }

    if (toolName === 'restore') {
      return (
        <ActionResultRenderer
          actionType="restore"
          success={parsedOutput.success !== false}
          title={parsedOutput.title}
          pageId={parsedOutput.pageId}
          driveId={parsedOutput.driveId}
          pageType={parsedOutput.type}
          message={parsedOutput.message}
          errorMessage={parsedOutput.error}
        />
      );
    }

    if (toolName === 'move_page') {
      return (
        <ActionResultRenderer
          actionType="move"
          success={parsedOutput.success !== false}
          title={parsedOutput.title}
          pageId={parsedOutput.pageId}
          driveId={parsedOutput.driveId}
          pageType={parsedOutput.type}
          oldParent={parsedOutput.oldParentTitle}
          newParent={parsedOutput.newParentTitle}
          errorMessage={parsedOutput.error}
        />
      );
    }

    if (toolName === 'edit_sheet_cells') {
      return (
        <ActionResultRenderer
          actionType="update"
          success={parsedOutput.success !== false}
          title={parsedOutput.title || 'Sheet'}
          pageId={parsedOutput.pageId}
          driveId={parsedOutput.driveId}
          pageType="SHEET"
          message={parsedOutput.summary || `${parsedOutput.updatedCount || 0} cells updated`}
          errorMessage={parsedOutput.error}
        />
      );
    }

    // === SEARCH TOOLS ===
    if (toolName === 'regex_search' && parsedOutput.results) {
      return (
        <SearchResultsRenderer
          results={parsedOutput.results}
          query={parsedInput?.pattern as string}
          searchType="regex"
          totalMatches={parsedOutput.totalMatches}
        />
      );
    }

    if (toolName === 'glob_search' && parsedOutput.results) {
      return (
        <SearchResultsRenderer
          results={parsedOutput.results}
          query={parsedInput?.pattern as string}
          searchType="glob"
        />
      );
    }

    if (toolName === 'multi_drive_search' && parsedOutput.results) {
      return (
        <SearchResultsRenderer
          results={parsedOutput.results}
          query={parsedInput?.pattern as string || parsedInput?.query as string}
          searchType="multi-drive"
          totalMatches={parsedOutput.totalMatches}
        />
      );
    }

    // === AGENT TOOLS ===
    if (toolName === 'list_agents' && parsedOutput.agents) {
      return <AgentListRenderer agents={parsedOutput.agents} />;
    }

    if (toolName === 'multi_drive_list_agents' && parsedOutput.agents) {
      return <AgentListRenderer agents={parsedOutput.agents} isMultiDrive />;
    }

    if (toolName === 'update_agent_config') {
      return (
        <ActionResultRenderer
          actionType="update"
          success={parsedOutput.success !== false}
          title={parsedOutput.agentTitle || 'Agent Configuration'}
          message={parsedOutput.message || 'Configuration updated'}
          errorMessage={parsedOutput.error}
        />
      );
    }

    // === WEB SEARCH ===
    if (toolName === 'web_search' && parsedOutput.results) {
      return (
        <WebSearchRenderer
          results={parsedOutput.results}
          query={parsedInput?.query as string}
        />
      );
    }

    // === ACTIVITY ===
    if (toolName === 'get_activity' && parsedOutput.activities) {
      return (
        <ActivityRenderer
          activities={parsedOutput.activities}
          period={parsedOutput.period}
        />
      );
    }

    // === TASK TOOLS ===
    if (toolName === 'get_assigned_tasks' && parsedOutput.tasks) {
      const tasks = parsedOutput.tasks as Array<{ id: string; title: string; status?: string; pageId?: string }>;
      return (
        <PageTreeRenderer
          tree={tasks.map(t => ({
            path: t.id,
            title: `${t.status === 'completed' ? '[Done] ' : ''}${t.title}`,
            type: 'TASK_LIST',
            pageId: t.pageId,
            children: []
          }))}
          title="Assigned Tasks"
        />
      );
    }

    // Default: show success/failure for any tool with success field
    if (typeof parsedOutput.success === 'boolean') {
      return (
        <ActionResultRenderer
          actionType="update"
          success={parsedOutput.success}
          title={parsedOutput.title || parsedOutput.name}
          message={parsedOutput.message}
          errorMessage={parsedOutput.error}
        />
      );
    }

    return null;
  }, [toolName, parsedInput, parsedOutput, error]);

  // Render with rich content (no Parameters/Result wrappers)
  return (
    <Tool className="my-2">
      <ToolHeader
        title={descriptiveTitle}
        type={`tool-${toolName}`}
        state={toolState}
      />
      <ToolContent>
        {richContent || (
          // Fallback: minimal loading/pending state
          <div className="px-3 py-2 text-sm text-muted-foreground">
            {state === 'input-streaming' || state === 'streaming' ? (
              'Processing...'
            ) : state === 'input-available' ? (
              'Waiting for result...'
            ) : (
              'Completed'
            )}
          </div>
        )}
      </ToolContent>
    </Tool>
  );
});

export const ToolCallRenderer: React.FC<ToolCallRendererProps> = memo(function ToolCallRenderer({ part }) {
  const toolName = part.toolName || part.type?.replace('tool-', '') || 'unknown_tool';

  // Task management - has its own dedicated renderer
  if (toolName === 'update_task') {
    return <TaskRenderer part={part} />;
  }

  // Ask Agent - has its own conversation UI
  if (toolName === 'ask_agent') {
    return <PageAgentConversationRenderer part={part} />;
  }

  return <ToolCallRendererInternal part={part} toolName={toolName} />;
});
