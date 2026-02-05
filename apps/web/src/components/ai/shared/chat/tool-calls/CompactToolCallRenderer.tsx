import React, { useState, memo, useMemo } from 'react';
import {
  FolderOpen,
  Plus,
  Edit,
  Trash,
  Database,
  Eye,
  Search,
  Move,
  RotateCcw,
  FilePlus,
  ChevronRight,
  ChevronDown,
  CheckCircle,
  AlertCircle,
  Loader2,
  Clock,
  Bot
} from 'lucide-react';

import { PageTreeRenderer, type TreeItem } from './PageTreeRenderer';
import { RichContentRenderer } from './RichContentRenderer';
import { RichDiffRenderer } from './RichDiffRenderer';
import { TaskRenderer } from './TaskRenderer';
import { ActionResultRenderer } from './ActionResultRenderer';
import { DriveListRenderer } from './DriveListRenderer';
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

interface CompactToolCallRendererProps {
  part: ToolPart;
}

// Helper function to count pages in tree structure (moved outside component)
const countPages = (items: TreeItem[]): number => {
  return items.reduce((count, item) => {
    return count + 1 + (item.children ? countPages(item.children) : 0);
  }, 0);
};

// Helper for safe JSON parsing
const safeJsonParse = (value: unknown): Record<string, unknown> | null => {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value === 'object' && value !== null) {
    return value as Record<string, unknown>;
  }
  return null;
};

// Tool name mapping (moved outside component to avoid recreation)
const TOOL_NAME_MAP: Record<string, string> = {
  'ask_agent': 'Ask Agent',
  'list_drives': 'List Drives',
  'list_pages': 'List Pages',
  'read_page': 'Read',
  'replace_lines': 'Replace',
  'create_page': 'Create',
  'rename_page': 'Rename',
  'trash': 'Trash',
  'restore': 'Restore',
  'move_page': 'Move',
  'list_trash': 'List Trash'
};

// Internal renderer component with hooks
const CompactToolCallRendererInternal: React.FC<{ part: ToolPart; toolName: string }> = memo(function CompactToolCallRendererInternal({ part, toolName }) {
  const [isExpanded, setIsExpanded] = useState(false);

  const state = part.state;
  const input = part.input;
  const output = part.output;
  const error = part.errorText;

  // Memoize parsed input
  const parsedInput = useMemo(() => safeJsonParse(input), [input]);

  // Memoize parsed output
  const parsedOutput = useMemo(() => safeJsonParse(output), [output]);

  // Memoize tool icon
  const toolIcon = useMemo(() => {
    const iconClass = "h-3 w-3";
    switch (toolName) {
      case 'ask_agent':
        return <Bot className={iconClass} />;
      case 'list_drives':
        return <Database className={iconClass} />;
      case 'list_pages':
        return <FolderOpen className={iconClass} />;
      case 'read_page':
        return <Eye className={iconClass} />;
      case 'replace_lines':
        return <Edit className={iconClass} />;
      case 'create_page':
        return <Plus className={iconClass} />;
      case 'rename_page':
        return <FilePlus className={iconClass} />;
      case 'trash':
        return <Trash className={iconClass} />;
      case 'restore':
        return <RotateCcw className={iconClass} />;
      case 'move_page':
        return <Move className={iconClass} />;
      case 'list_trash':
        return <Trash className={iconClass} />;
      default:
        return <Search className={iconClass} />;
    }
  }, [toolName]);

  // Memoize status icon
  const statusIcon = useMemo(() => {
    const iconClass = "h-3 w-3";
    switch (state) {
      case 'output-available':
      case 'done':
        return error ? <AlertCircle className={`${iconClass} text-red-500`} /> : <CheckCircle className={`${iconClass} text-green-500`} />;
      case 'input-available':
      case 'streaming':
        return <Loader2 className={`${iconClass} text-primary animate-spin`} />;
      case 'output-error':
        return <AlertCircle className={`${iconClass} text-red-500`} />;
      default:
        return <Clock className={`${iconClass} text-gray-400`} />;
    }
  }, [state, error]);

  // Memoize formatted tool name
  const formattedToolName = useMemo(() => {
    return TOOL_NAME_MAP[toolName] || toolName
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }, [toolName]);

  // Memoize descriptive title
  const descriptiveTitle = useMemo(() => {
    if (!parsedInput) return formattedToolName;

    const params = parsedInput;

    // File-based tools
    if (['read_page', 'replace_lines', 'list_pages'].includes(toolName)) {
      if (params.title) return `${formattedToolName}: "${params.title}"`;
      if (params.dir) return `${formattedToolName}: ${params.dir}`;
    }

    // Title-based tools
    if (['create_page', 'move_page'].includes(toolName)) {
      if (params.title) return `${formattedToolName}: "${params.title}"`;
      if (params.name) return `${formattedToolName}: "${params.name}"`;
    }

    // Rename uses currentTitle for display (title is the new name)
    if (toolName === 'rename_page') {
      if (params.currentTitle) return `${formattedToolName}: "${params.currentTitle}"`;
    }

    // Trash/Restore
    if (['trash', 'restore'].includes(toolName)) {
      if (params.title || params.name) return `${formattedToolName}: "${params.title || params.name}"`;
    }

    // Drive-based tools - show which drive
    if (['list_pages', 'list_trash'].includes(toolName)) {
      if (params.driveSlug) return `${formattedToolName}: "${params.driveSlug}"`;
    }

    // Drive creation
    if (toolName === 'create_drive') {
      if (params.name) return `${formattedToolName}: "${params.name}"`;
    }

    // Drive rename - show current name
    if (toolName === 'rename_drive') {
      if (params.currentName) return `${formattedToolName}: "${params.currentName}"`;
    }

    return formattedToolName;
  }, [parsedInput, formattedToolName, toolName]);

  // Memoize compact summary
  const compactSummary = useMemo((): string => {
    if (error) return 'Failed';

    if (state === 'output-available' || state === 'done') {
      if (!parsedOutput) return 'Done';

      const result = parsedOutput as Record<string, unknown>;

      if (toolName === 'ask_agent' && result.response) {
        const text = String(result.response);
        return text.length > 30 ? text.substring(0, 27) + '...' : text;
      }

      // Very compact summaries
      if (toolName === 'list_drives' && result.drives) {
        return `${(result.drives as unknown[]).length} drives`;
      }

      if (toolName === 'list_pages' && result.tree) {
        const pageCount = countPages((result.tree as TreeItem[]) || []);
        return `${pageCount} pages`;
      }

      if (toolName === 'read_page') {
        const title = (result.title as string) || 'page';
        return title.length > 20 ? title.substring(0, 17) + '...' : title;
      }

      if (result.message) {
        const msg = result.message as string;
        return msg.length > 30 ? msg.substring(0, 27) + '...' : msg;
      }

      if (result.title) {
        const title = result.title as string;
        return title.length > 20 ? title.substring(0, 17) + '...' : title;
      }

      return 'Complete';
    }

    if (state === 'input-available' || state === 'streaming') {
      return 'Running...';
    }

    return 'Pending';
  }, [error, state, parsedOutput, toolName]);

  // Memoize rich content for expanded view
  const richContent = useMemo((): React.ReactNode | null => {
    if (!parsedOutput) return null;
    const result = parsedOutput as Record<string, unknown>;

    // === DRIVE TOOLS ===
    if (toolName === 'list_drives' && result.drives) {
      const drives = (result.drives as Array<{ id: string; slug: string; title?: string; name?: string; description?: string; isPersonal?: boolean; memberCount?: number }>).map(d => ({
        id: d.id,
        name: d.name || d.title || 'Untitled',
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
          success={result.success !== false}
          title={(result.name || result.title) as string | undefined}
          oldTitle={result.oldName as string | undefined}
          message={result.message as string | undefined}
          errorMessage={result.error as string | undefined}
        />
      );
    }

    if (toolName === 'update_drive_context') {
      return (
        <ActionResultRenderer
          actionType="update"
          success={result.success !== false}
          title="Workspace Context"
          message={(result.message as string | undefined) || 'Context updated successfully'}
          errorMessage={result.error as string | undefined}
        />
      );
    }

    // === PAGE READ TOOLS ===
    if (toolName === 'list_pages' && result.tree) {
      return (
        <PageTreeRenderer
          tree={result.tree as TreeItem[]}
          driveName={result.driveName as string | undefined}
          driveId={result.driveId as string | undefined}
          maxHeight={200}
        />
      );
    }

    if (toolName === 'list_trash' && result.tree) {
      return (
        <PageTreeRenderer
          tree={result.tree as TreeItem[]}
          driveName={result.driveName as string | undefined}
          driveId={result.driveId as string | undefined}
          title="Trash"
          maxHeight={200}
        />
      );
    }

    if (toolName === 'read_page' && (result.rawContent != null || result.content != null)) {
      return (
        <RichContentRenderer
          title={(result.title as string) || 'Document'}
          content={(result.rawContent ?? result.content) as string}
          pageId={result.pageId as string | undefined}
          pageType={result.type as string | undefined}
          maxHeight={200}
        />
      );
    }

    if (toolName === 'list_conversations' && result.conversations != null) {
      const conversations = result.conversations as Array<{ id: string; title?: string }>;
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
          maxHeight={200}
        />
      );
    }

    if (toolName === 'read_conversation' && result.content != null) {
      return (
        <RichContentRenderer
          title={(result.title as string | undefined) || 'Conversation'}
          content={result.content as string}
          pageId={result.pageId as string | undefined}
          pageType="AI_CHAT"
          maxHeight={200}
        />
      );
    }

    // === PAGE WRITE TOOLS ===
    if (toolName === 'replace_lines') {
      if (result.success && result.oldContent != null && result.newContent != null) {
        return (
          <RichDiffRenderer
            title={(result.title as string) || 'Modified Document'}
            oldContent={result.oldContent as string}
            newContent={result.newContent as string}
            pageId={result.pageId as string | undefined}
            changeSummary={result.summary as string | undefined}
            maxHeight={200}
          />
        );
      }
      if (result.success && result.newContent != null) {
        return (
          <RichContentRenderer
            title={(result.title as string) || 'Modified Document'}
            content={result.newContent as string}
            pageId={result.pageId as string | undefined}
            pageType={result.type as string | undefined}
            maxHeight={200}
          />
        );
      }
      return (
        <ActionResultRenderer
          actionType="update"
          success={result.success !== false}
          title={result.title as string | undefined}
          pageId={result.pageId as string | undefined}
          pageType={result.type as string | undefined}
          errorMessage={result.error as string | undefined}
        />
      );
    }

    if (toolName === 'create_page') {
      return (
        <ActionResultRenderer
          actionType="create"
          success={result.success !== false}
          title={result.title as string | undefined}
          pageId={result.pageId as string | undefined}
          driveId={result.driveId as string | undefined}
          pageType={result.type as string | undefined}
          message={result.message as string | undefined}
          errorMessage={result.error as string | undefined}
        />
      );
    }

    if (toolName === 'rename_page') {
      return (
        <ActionResultRenderer
          actionType="rename"
          success={result.success !== false}
          title={(result.newTitle || result.title) as string | undefined}
          oldTitle={result.oldTitle as string | undefined}
          pageId={result.pageId as string | undefined}
          driveId={result.driveId as string | undefined}
          pageType={result.type as string | undefined}
          errorMessage={result.error as string | undefined}
        />
      );
    }

    if (toolName === 'trash') {
      return (
        <ActionResultRenderer
          actionType="trash"
          success={result.success !== false}
          title={result.title as string | undefined}
          pageType={result.type as string | undefined}
          message={result.message as string | undefined}
          errorMessage={result.error as string | undefined}
        />
      );
    }

    if (toolName === 'restore') {
      return (
        <ActionResultRenderer
          actionType="restore"
          success={result.success !== false}
          title={result.title as string | undefined}
          pageId={result.pageId as string | undefined}
          driveId={result.driveId as string | undefined}
          pageType={result.type as string | undefined}
          message={result.message as string | undefined}
          errorMessage={result.error as string | undefined}
        />
      );
    }

    if (toolName === 'move_page') {
      return (
        <ActionResultRenderer
          actionType="move"
          success={result.success !== false}
          title={result.title as string | undefined}
          pageId={result.pageId as string | undefined}
          driveId={result.driveId as string | undefined}
          pageType={result.type as string | undefined}
          oldParent={result.oldParentTitle as string | undefined}
          newParent={result.newParentTitle as string | undefined}
          errorMessage={result.error as string | undefined}
        />
      );
    }

    if (toolName === 'edit_sheet_cells') {
      return (
        <ActionResultRenderer
          actionType="update"
          success={result.success !== false}
          title={(result.title as string | undefined) || 'Sheet'}
          pageId={result.pageId as string | undefined}
          driveId={result.driveId as string | undefined}
          pageType="SHEET"
          message={(result.summary as string | undefined) || `${(result.updatedCount as number | undefined) || 0} cells updated`}
          errorMessage={result.error as string | undefined}
        />
      );
    }

    // === SEARCH TOOLS ===
    if (toolName === 'regex_search' && result.results) {
      return (
        <SearchResultsRenderer
          results={result.results as SearchResult[]}
          query={parsedInput?.pattern as string}
          searchType="regex"
          totalMatches={result.totalMatches as number | undefined}
        />
      );
    }

    if (toolName === 'glob_search' && result.results) {
      return (
        <SearchResultsRenderer
          results={result.results as SearchResult[]}
          query={parsedInput?.pattern as string}
          searchType="glob"
        />
      );
    }

    if (toolName === 'multi_drive_search' && result.results) {
      return (
        <SearchResultsRenderer
          results={result.results as SearchResult[]}
          query={(parsedInput?.pattern || parsedInput?.query) as string}
          searchType="multi-drive"
          totalMatches={result.totalMatches as number | undefined}
        />
      );
    }

    // === AGENT TOOLS ===
    if (toolName === 'list_agents' && result.agents) {
      return <AgentListRenderer agents={result.agents as AgentInfo[]} />;
    }

    if (toolName === 'multi_drive_list_agents' && result.agents) {
      return <AgentListRenderer agents={result.agents as AgentInfo[]} isMultiDrive />;
    }

    if (toolName === 'update_agent_config') {
      return (
        <ActionResultRenderer
          actionType="update"
          success={result.success !== false}
          title={(result.agentTitle as string | undefined) || 'Agent Configuration'}
          message={(result.message as string | undefined) || 'Configuration updated'}
          errorMessage={result.error as string | undefined}
        />
      );
    }

    if (toolName === 'ask_agent' && result.response) {
      return (
        <RichContentRenderer
          title="Agent Response"
          content={String(result.response)}
          maxHeight={200}
        />
      );
    }

    // === WEB SEARCH ===
    if (toolName === 'web_search' && result.results) {
      return (
        <WebSearchRenderer
          results={result.results as WebSearchResult[]}
          query={parsedInput?.query as string}
        />
      );
    }

    // === ACTIVITY ===
    if (toolName === 'get_activity') {
      if (result.activities) {
        return (
          <ActivityRenderer
            activities={result.activities as ActivityItem[]}
            period={result.period as string | undefined}
          />
        );
      }
      if (result.drives && Array.isArray(result.drives)) {
        const actors = (result.actors || []) as Array<{ email: string; name: string | null; isYou: boolean; count: number }>;
        const driveGroups = result.drives as Array<{
          drive: { id: string; name: string; slug: string };
          activities: Array<{
            id: string; ts: string; op: string; res: string;
            title: string | null; pageId: string | null; actor: number; ai?: string;
          }>;
        }>;

        const opToAction = (op: string): 'created' | 'updated' | 'deleted' | 'restored' | 'moved' | 'renamed' => {
          switch (op) {
            case 'create': return 'created';
            case 'update': return 'updated';
            case 'delete': case 'trash': return 'deleted';
            case 'restore': return 'restored';
            case 'move': case 'reorder': return 'moved';
            case 'rename': return 'renamed';
            default: return 'updated';
          }
        };

        const flatActivities: ActivityItem[] = [];
        for (const group of driveGroups) {
          for (const activity of group.activities) {
            const actor = actors[activity.actor];
            flatActivities.push({
              id: activity.id,
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

        flatActivities.sort((a, b) => {
          const timeA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
          const timeB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
          return timeB - timeA;
        });

        const meta = result.meta as { window?: string } | undefined;
        const period = meta?.window ? `Last ${meta.window}` : undefined;

        return <ActivityRenderer activities={flatActivities} period={period} />;
      }
    }

    // === TASK TOOLS ===
    if (toolName === 'get_assigned_tasks' && result.tasks) {
      const tasks = result.tasks as Array<{ id: string; title: string; status?: string; pageId?: string }>;
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
          maxHeight={200}
        />
      );
    }

    // Default: show success/failure for any tool with success field
    if (typeof result.success === 'boolean') {
      return (
        <ActionResultRenderer
          actionType="update"
          success={result.success}
          title={(result.title || result.name) as string | undefined}
          message={result.message as string | undefined}
          errorMessage={result.error as string | undefined}
        />
      );
    }

    return null;
  }, [toolName, parsedInput, parsedOutput]);

  // Memoize expanded details content
  const expandedDetails = useMemo(() => {
    if (!isExpanded) return null;

    return (
      <div className="mt-1 max-w-full break-words">
        {error ? (
          <ActionResultRenderer
            actionType="update"
            success={false}
            errorMessage={error}
            title={parsedInput?.title as string}
          />
        ) : richContent ? (
          <div className="text-[10px]">{richContent}</div>
        ) : (
          <div className="p-1.5 bg-gray-50 dark:bg-gray-800/50 rounded text-[10px]">
            <span className="text-gray-500 dark:text-gray-400">
              {state === 'input-streaming' || state === 'streaming' ? 'Processing...' :
               state === 'input-available' ? 'Waiting for result...' : 'Completed'}
            </span>
          </div>
        )}
      </div>
    );
  }, [isExpanded, error, richContent, parsedInput, state]);

  return (
    <div className="py-0.5 text-[11px] max-w-full">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center space-x-1.5 text-left hover:bg-muted/30 rounded py-0.5 px-1 transition-colors max-w-full"
      >
        {isExpanded ? <ChevronDown className="h-3 w-3 flex-shrink-0" /> : <ChevronRight className="h-3 w-3 flex-shrink-0" />}
        <div className="flex-shrink-0">{toolIcon}</div>
        <span className="font-medium truncate flex-1 min-w-0" title={descriptiveTitle}>{descriptiveTitle}</span>
        <div className="flex-shrink-0">{statusIcon}</div>
        <span className="text-gray-500 dark:text-gray-400 truncate max-w-[80px] min-w-0">
          {compactSummary}
        </span>
      </button>

      {expandedDetails}
    </div>
  );
});

export const CompactToolCallRenderer: React.FC<CompactToolCallRendererProps> = memo(function CompactToolCallRenderer({ part }) {
  const toolName = part.toolName || part.type?.replace('tool-', '') || '';

  // Task management tools - render with TaskRenderer
  if (toolName === 'update_task') {
    return <TaskRenderer part={part} />;
  }

  return <CompactToolCallRendererInternal part={part} toolName={toolName} />;
});
