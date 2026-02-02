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
import { PageTreeRenderer, type TreeItem } from './PageTreeRenderer';
import { DriveListRenderer, type DriveInfo } from './DriveListRenderer';
import { ActionResultRenderer } from './ActionResultRenderer';
import { SearchResultsRenderer, type SearchResult } from './SearchResultsRenderer';
import { AgentListRenderer, type AgentInfo } from './AgentListRenderer';
import { ActivityRenderer, type ActivityItem } from './ActivityRenderer';
import { WebSearchRenderer, type WebSearchResult } from './WebSearchRenderer';

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

// Helper to parse list_pages paths format into tree structure
// Path format: "📁 [FOLDER](Task) ID: xxx Path: /drive/folder"
const parsePathsToTree = (paths: string[], driveId?: string): TreeItem[] => {
  const pathRegex = /^\S+\s+\[([^\]]+)\](?:\s+\(Task\))?\s+ID:\s+(\S+)\s+Path:\s+(.+)$/;

  interface ParsedPage {
    type: string;
    pageId: string;
    fullPath: string;
    title: string;
    pathSegments: string[];
  }

  const parsedPages: ParsedPage[] = [];

  for (const path of paths) {
    const match = path.match(pathRegex);
    if (match) {
      const [, type, pageId, fullPath] = match;
      const segments = fullPath.split('/').filter(Boolean);
      const title = segments[segments.length - 1] || 'Untitled';
      parsedPages.push({
        type,
        pageId,
        fullPath,
        title,
        pathSegments: segments,
      });
    }
  }

  // Build tree from parsed pages
  const buildTreeFromParsed = (pages: ParsedPage[], depth: number, parentPath: string[]): TreeItem[] => {
    const result: TreeItem[] = [];
    const seen = new Map<string, { page: ParsedPage; children: ParsedPage[] }>();

    for (const page of pages) {
      if (page.pathSegments.length <= depth) continue;

      const currentSegment = page.pathSegments[depth];
      const isDirectChild = page.pathSegments.length === depth + 1;

      if (!seen.has(currentSegment)) {
        seen.set(currentSegment, {
          page: isDirectChild ? page : page,
          children: []
        });
      }

      const entry = seen.get(currentSegment)!;
      if (isDirectChild) {
        entry.page = page;
      } else {
        entry.children.push(page);
      }
    }

    for (const [segment, { page, children }] of seen) {
      const currentPath = [...parentPath, segment];
      const item: TreeItem = {
        path: '/' + currentPath.join('/'),
        title: segment,
        type: page.type,
        pageId: page.pageId,
        children: buildTreeFromParsed(children, depth + 1, currentPath),
      };
      result.push(item);
    }

    return result;
  };

  // Start building from depth 1 (skip drive slug at depth 0)
  return buildTreeFromParsed(parsedPages, 1, []);
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

  // Memoize parsed input/output using consistent parsing
  const parsedInput = useMemo(() => safeJsonParse(input), [input]);
  const parsedOutput = useMemo(() => {
    // Use strict null/undefined check to preserve valid falsy values (0, false, "")
    if (output == null) return null;
    return safeJsonParse(output);
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
      // Transform drive data: tool returns 'title' but renderer expects 'name'
      const drives = (parsedOutput.drives as Array<{ id: string; slug: string; title?: string; name?: string; description?: string; isPersonal?: boolean; memberCount?: number }>).map(d => ({
        id: d.id,
        name: d.name || d.title || 'Untitled', // Prefer name, fall back to title
        slug: d.slug,
        description: d.description,
        isPersonal: d.isPersonal,
        memberCount: d.memberCount,
      }));
      return <DriveListRenderer drives={drives} />;
    }

    if (toolName === 'create_drive' || toolName === 'rename_drive') {
      return (
        <ActionResultRenderer
          actionType={toolName === 'create_drive' ? 'create' : 'rename'}
          success={parsedOutput.success !== false}
          title={(parsedOutput.name || parsedOutput.title) as string | undefined}
          oldTitle={parsedOutput.oldName as string | undefined}
          message={parsedOutput.message as string | undefined}
          errorMessage={parsedOutput.error as string | undefined}
        />
      );
    }

    if (toolName === 'update_drive_context') {
      return (
        <ActionResultRenderer
          actionType="update"
          success={parsedOutput.success !== false}
          title="Workspace Context"
          message={(parsedOutput.message as string | undefined) || 'Context updated successfully'}
          errorMessage={parsedOutput.error as string | undefined}
        />
      );
    }

    // === PAGE READ TOOLS ===
    // Handle both tree format (newer) and paths format (current)
    if (toolName === 'list_pages') {
      if (parsedOutput.tree) {
        return (
          <PageTreeRenderer
            tree={parsedOutput.tree as TreeItem[]}
            driveName={parsedOutput.driveName as string | undefined}
            driveId={parsedOutput.driveId as string | undefined}
          />
        );
      }
      // Convert paths array format to tree
      if (parsedOutput.paths && Array.isArray(parsedOutput.paths)) {
        const tree = parsePathsToTree(
          parsedOutput.paths as string[],
          parsedOutput.driveId as string | undefined
        );
        return (
          <PageTreeRenderer
            tree={tree}
            driveName={parsedOutput.driveSlug as string | undefined}
            driveId={parsedOutput.driveId as string | undefined}
          />
        );
      }
    }

    if (toolName === 'list_trash' && parsedOutput.tree) {
      return (
        <PageTreeRenderer
          tree={parsedOutput.tree as TreeItem[]}
          driveName={parsedOutput.driveName as string | undefined}
          driveId={parsedOutput.driveId as string | undefined}
          title="Trash"
        />
      );
    }

    if (toolName === 'read_page' && (parsedOutput.rawContent || parsedOutput.content)) {
      return (
        <RichContentRenderer
          title={(parsedOutput.title as string | undefined) || 'Document'}
          content={(parsedOutput.rawContent || parsedOutput.content) as string}
          pageId={parsedOutput.pageId as string | undefined}
          pageType={parsedOutput.type as string | undefined}
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
          title={(parsedOutput.title as string | undefined) || 'Conversation'}
          content={parsedOutput.content as string}
          pageId={parsedOutput.pageId as string | undefined}
          pageType="AI_CHAT"
        />
      );
    }

    // === PAGE WRITE TOOLS ===
    if (toolName === 'replace_lines') {
      if (parsedOutput.success && parsedOutput.oldContent && parsedOutput.newContent) {
        return (
          <RichDiffRenderer
            title={(parsedOutput.title as string | undefined) || 'Document'}
            oldContent={parsedOutput.oldContent as string}
            newContent={parsedOutput.newContent as string}
            pageId={parsedOutput.pageId as string | undefined}
            changeSummary={parsedOutput.summary as string | undefined}
          />
        );
      }
      if (parsedOutput.success && parsedOutput.newContent) {
        return (
          <RichContentRenderer
            title={(parsedOutput.title as string | undefined) || 'Document'}
            content={parsedOutput.newContent as string}
            pageId={parsedOutput.pageId as string | undefined}
          />
        );
      }
      return (
        <ActionResultRenderer
          actionType="update"
          success={parsedOutput.success !== false}
          title={parsedOutput.title as string | undefined}
          pageId={parsedOutput.pageId as string | undefined}
          pageType={parsedOutput.type as string | undefined}
          errorMessage={parsedOutput.error as string | undefined}
        />
      );
    }

    if (toolName === 'create_page') {
      return (
        <ActionResultRenderer
          actionType="create"
          success={parsedOutput.success !== false}
          title={parsedOutput.title as string | undefined}
          pageId={parsedOutput.pageId as string | undefined}
          driveId={parsedOutput.driveId as string | undefined}
          pageType={parsedOutput.type as string | undefined}
          message={parsedOutput.message as string | undefined}
          errorMessage={parsedOutput.error as string | undefined}
        />
      );
    }

    if (toolName === 'rename_page') {
      return (
        <ActionResultRenderer
          actionType="rename"
          success={parsedOutput.success !== false}
          title={(parsedOutput.newTitle || parsedOutput.title) as string | undefined}
          oldTitle={parsedOutput.oldTitle as string | undefined}
          pageId={parsedOutput.pageId as string | undefined}
          driveId={parsedOutput.driveId as string | undefined}
          pageType={parsedOutput.type as string | undefined}
          errorMessage={parsedOutput.error as string | undefined}
        />
      );
    }

    if (toolName === 'trash') {
      return (
        <ActionResultRenderer
          actionType="trash"
          success={parsedOutput.success !== false}
          title={parsedOutput.title as string | undefined}
          pageType={parsedOutput.type as string | undefined}
          message={parsedOutput.message as string | undefined}
          errorMessage={parsedOutput.error as string | undefined}
        />
      );
    }

    if (toolName === 'restore') {
      return (
        <ActionResultRenderer
          actionType="restore"
          success={parsedOutput.success !== false}
          title={parsedOutput.title as string | undefined}
          pageId={parsedOutput.pageId as string | undefined}
          driveId={parsedOutput.driveId as string | undefined}
          pageType={parsedOutput.type as string | undefined}
          message={parsedOutput.message as string | undefined}
          errorMessage={parsedOutput.error as string | undefined}
        />
      );
    }

    if (toolName === 'move_page') {
      return (
        <ActionResultRenderer
          actionType="move"
          success={parsedOutput.success !== false}
          title={parsedOutput.title as string | undefined}
          pageId={parsedOutput.pageId as string | undefined}
          driveId={parsedOutput.driveId as string | undefined}
          pageType={parsedOutput.type as string | undefined}
          oldParent={parsedOutput.oldParentTitle as string | undefined}
          newParent={parsedOutput.newParentTitle as string | undefined}
          errorMessage={parsedOutput.error as string | undefined}
        />
      );
    }

    if (toolName === 'edit_sheet_cells') {
      return (
        <ActionResultRenderer
          actionType="update"
          success={parsedOutput.success !== false}
          title={(parsedOutput.title as string | undefined) || 'Sheet'}
          pageId={parsedOutput.pageId as string | undefined}
          driveId={parsedOutput.driveId as string | undefined}
          pageType="SHEET"
          message={(parsedOutput.summary as string | undefined) || `${(parsedOutput.updatedCount as number | undefined) || 0} cells updated`}
          errorMessage={parsedOutput.error as string | undefined}
        />
      );
    }

    // === SEARCH TOOLS ===
    if (toolName === 'regex_search' && parsedOutput.results) {
      return (
        <SearchResultsRenderer
          results={parsedOutput.results as SearchResult[]}
          query={parsedInput?.pattern as string}
          searchType="regex"
          totalMatches={parsedOutput.totalMatches as number | undefined}
        />
      );
    }

    if (toolName === 'glob_search' && parsedOutput.results) {
      return (
        <SearchResultsRenderer
          results={parsedOutput.results as SearchResult[]}
          query={parsedInput?.pattern as string}
          searchType="glob"
        />
      );
    }

    if (toolName === 'multi_drive_search' && parsedOutput.results) {
      return (
        <SearchResultsRenderer
          results={parsedOutput.results as SearchResult[]}
          query={(parsedInput?.pattern || parsedInput?.query) as string}
          searchType="multi-drive"
          totalMatches={parsedOutput.totalMatches as number | undefined}
        />
      );
    }

    // === AGENT TOOLS ===
    if (toolName === 'list_agents' && parsedOutput.agents) {
      return <AgentListRenderer agents={parsedOutput.agents as AgentInfo[]} />;
    }

    if (toolName === 'multi_drive_list_agents' && parsedOutput.agents) {
      return <AgentListRenderer agents={parsedOutput.agents as AgentInfo[]} isMultiDrive />;
    }

    if (toolName === 'update_agent_config') {
      return (
        <ActionResultRenderer
          actionType="update"
          success={parsedOutput.success !== false}
          title={(parsedOutput.agentTitle as string | undefined) || 'Agent Configuration'}
          message={(parsedOutput.message as string | undefined) || 'Configuration updated'}
          errorMessage={parsedOutput.error as string | undefined}
        />
      );
    }

    // === WEB SEARCH ===
    if (toolName === 'web_search' && parsedOutput.results) {
      return (
        <WebSearchRenderer
          results={parsedOutput.results as WebSearchResult[]}
          query={parsedInput?.query as string}
        />
      );
    }

    // === ACTIVITY ===
    // Handle both flat 'activities' format and grouped 'drives' format
    if (toolName === 'get_activity') {
      // Direct activities array format
      if (parsedOutput.activities) {
        return (
          <ActivityRenderer
            activities={parsedOutput.activities as ActivityItem[]}
            period={parsedOutput.period as string | undefined}
          />
        );
      }
      // Grouped drives format from activity-tools.ts
      if (parsedOutput.drives && Array.isArray(parsedOutput.drives)) {
        const actors = (parsedOutput.actors || []) as Array<{ email: string; name: string | null; isYou: boolean; count: number }>;
        const driveGroups = parsedOutput.drives as Array<{
          drive: { id: string; name: string; slug: string; context: string | null };
          activities: Array<{
            ts: string;
            op: string;
            res: string;
            title: string | null;
            pageId: string | null;
            actor: number;
            ai?: string;
            fields?: string[];
            delta?: Record<string, unknown>;
          }>;
          stats: { total: number; byOp: Record<string, number>; aiCount: number };
        }>;

        // Map operation names to action types
        const opToAction = (op: string): 'created' | 'updated' | 'deleted' | 'restored' | 'moved' | 'commented' | 'renamed' => {
          switch (op) {
            case 'create': return 'created';
            case 'update': return 'updated';
            case 'delete':
            case 'trash': return 'deleted';
            case 'restore': return 'restored';
            case 'move':
            case 'reorder': return 'moved';
            case 'rename': return 'renamed';
            default: return 'updated';
          }
        };

        // Flatten grouped activities
        const flatActivities: ActivityItem[] = [];
        for (const group of driveGroups) {
          for (const activity of group.activities) {
            const actor = actors[activity.actor];
            flatActivities.push({
              id: `${group.drive.id}-${activity.ts}-${activity.pageId || 'no-page'}`,
              action: opToAction(activity.op),
              pageId: activity.pageId || undefined,
              pageTitle: activity.title || undefined,
              pageType: activity.res === 'page' ? undefined : activity.res,
              driveId: group.drive.id,
              driveName: group.drive.name,
              actorName: actor?.name || actor?.email || undefined,
              timestamp: activity.ts,
              summary: activity.ai ? `AI-generated (${activity.ai})` : undefined,
            });
          }
        }

        // Sort by timestamp descending
        flatActivities.sort((a, b) => {
          const timeA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
          const timeB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
          return timeB - timeA;
        });

        const meta = parsedOutput.meta as { window?: string } | undefined;
        const period = meta?.window ? `Last ${meta.window}` : undefined;

        return (
          <ActivityRenderer
            activities={flatActivities}
            period={period}
          />
        );
      }
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
          title={(parsedOutput.title || parsedOutput.name) as string | undefined}
          message={parsedOutput.message as string | undefined}
          errorMessage={parsedOutput.error as string | undefined}
        />
      );
    }

    // Fallback: display raw output for unhandled tools (preserves debugging visibility)
    if (output != null) {
      const rawContent = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
      return (
        <div className="rounded-lg border bg-card overflow-hidden my-2 shadow-sm">
          <div className="px-3 py-2 bg-muted/30 border-b">
            <span className="text-sm font-medium text-muted-foreground">Result</span>
          </div>
          <pre className="p-3 text-xs overflow-auto max-h-[300px] bg-muted/20">
            <code>{rawContent}</code>
          </pre>
        </div>
      );
    }

    return null;
  }, [toolName, parsedInput, parsedOutput, error, output]);

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
