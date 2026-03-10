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
  Bot,
  MessageSquare
} from 'lucide-react';

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
import { DriveListRenderer } from './DriveListRenderer';
import { ActionResultRenderer } from './ActionResultRenderer';
import { SearchResultsRenderer, type SearchResult } from './SearchResultsRenderer';
import { AgentListRenderer, type AgentInfo } from './AgentListRenderer';
import { ActivityRenderer, type ActivityItem } from './ActivityRenderer';
import { WebSearchRenderer, type WebSearchResult } from './WebSearchRenderer';
import {
  safeJsonParse,
  safeJsonParseWithRaw,
  buildChannelTranscript,
  getSendChannelMessagePreview,
  TOOL_NAME_MAP,
  parsePathsToTree,
  countPages,
} from './tool-helpers';

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
  compact?: boolean;
}

const getToolIcon = (toolName: string, className: string) => {
  switch (toolName) {
    case 'ask_agent': return <Bot className={className} />;
    case 'list_drives': return <Database className={className} />;
    case 'list_pages': return <FolderOpen className={className} />;
    case 'read_page': return <Eye className={className} />;
    case 'send_channel_message': return <MessageSquare className={className} />;
    case 'replace_lines': return <Edit className={className} />;
    case 'create_page': return <Plus className={className} />;
    case 'rename_page': return <FilePlus className={className} />;
    case 'trash': return <Trash className={className} />;
    case 'restore': return <RotateCcw className={className} />;
    case 'move_page': return <Move className={className} />;
    case 'list_trash': return <Trash className={className} />;
    default: return <Search className={className} />;
  }
};

const getStatusIcon = (state: string | undefined, error: string | undefined, className: string) => {
  switch (state) {
    case 'output-available':
    case 'done':
      return error ? <AlertCircle className={`${className} text-red-500`} /> : <CheckCircle className={`${className} text-green-500`} />;
    case 'input-available':
    case 'streaming':
      return <Loader2 className={`${className} text-primary animate-spin`} />;
    case 'output-error':
      return <AlertCircle className={`${className} text-red-500`} />;
    default:
      return <Clock className={`${className} text-gray-400`} />;
  }
};

const getCompactSummary = (
  toolName: string,
  state: string | undefined,
  error: string | undefined,
  parsedInput: Record<string, unknown> | null,
  parsedOutput: Record<string, unknown> | null
): string => {
  if (error) return 'Failed';

  if (state === 'output-available' || state === 'done') {
    if (!parsedOutput) return 'Done';

    if (toolName === 'ask_agent' && parsedOutput.response) {
      const text = String(parsedOutput.response);
      return text.length > 30 ? text.substring(0, 27) + '...' : text;
    }

    if (toolName === 'list_drives' && parsedOutput.drives) {
      return `${(parsedOutput.drives as unknown[]).length} drives`;
    }

    if (toolName === 'list_pages' && parsedOutput.tree) {
      const pageCount = countPages((parsedOutput.tree as TreeItem[]) || []);
      return `${pageCount} pages`;
    }

    if (toolName === 'read_page') {
      const title = (parsedOutput.title as string) || 'page';
      return title.length > 20 ? title.substring(0, 17) + '...' : title;
    }

    if (toolName === 'send_channel_message') {
      const preview = getSendChannelMessagePreview(parsedInput, parsedOutput);
      if (preview) {
        return preview.length > 30 ? preview.substring(0, 27) + '...' : preview;
      }
    }

    if (parsedOutput.message) {
      const msg = parsedOutput.message as string;
      return msg.length > 30 ? msg.substring(0, 27) + '...' : msg;
    }

    if (parsedOutput.title) {
      const title = parsedOutput.title as string;
      return title.length > 20 ? title.substring(0, 17) + '...' : title;
    }

    return 'Complete';
  }

  if (state === 'input-available' || state === 'streaming') {
    return 'Running...';
  }

  return 'Pending';
};

const buildRichContent = (
  toolName: string,
  parsedInput: Record<string, unknown> | null,
  parsedOutput: Record<string, unknown> | null,
  error: string | undefined,
  compact: boolean
): React.ReactNode | null => {
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

  const maxHeight = compact ? 200 : undefined;

  // === DRIVE TOOLS ===
  if (toolName === 'list_drives' && parsedOutput.drives) {
    const drives = (parsedOutput.drives as Array<{ id: string; slug: string; title?: string; name?: string; description?: string; isPersonal?: boolean; memberCount?: number }>).map(d => ({
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
  if (toolName === 'list_pages') {
    if (parsedOutput.tree) {
      return (
        <PageTreeRenderer
          tree={parsedOutput.tree as TreeItem[]}
          driveName={parsedOutput.driveName as string | undefined}
          driveId={parsedOutput.driveId as string | undefined}
          maxHeight={maxHeight}
        />
      );
    }
    if (parsedOutput.paths && Array.isArray(parsedOutput.paths)) {
      const tree = parsePathsToTree(
        parsedOutput.paths as string[],
        parsedOutput.driveId as string | undefined
      );
      return (
        <PageTreeRenderer
          tree={tree}
          driveName={(parsedOutput.driveName ?? parsedOutput.driveSlug) as string | undefined}
          driveId={parsedOutput.driveId as string | undefined}
          maxHeight={maxHeight}
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
        maxHeight={maxHeight}
      />
    );
  }

  if (toolName === 'read_page') {
    const directContentValue = parsedOutput.rawContent ?? parsedOutput.content;
    const directContent = typeof directContentValue === 'string' && directContentValue.length > 0
      ? directContentValue
      : undefined;
    const channelTranscript = buildChannelTranscript(parsedOutput.channelMessages);
    const hasChannelMessagesArray = Array.isArray(parsedOutput.channelMessages);
    const content = directContent ?? channelTranscript ?? (hasChannelMessagesArray ? 'Channel has no messages yet.' : undefined);

    if (content !== undefined) {
      return (
        <RichContentRenderer
          title={(parsedOutput.title as string | undefined) || 'Document'}
          content={content}
          pageId={parsedOutput.pageId as string | undefined}
          pageType={parsedOutput.type as string | undefined}
          maxHeight={maxHeight}
        />
      );
    }
  }

  if (toolName === 'list_conversations' && parsedOutput.conversations) {
    const conversations = parsedOutput.conversations as Array<{ id: string; title?: string }>;
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
        maxHeight={maxHeight}
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
        maxHeight={maxHeight}
      />
    );
  }

  // === PAGE WRITE TOOLS ===
  if (toolName === 'replace_lines') {
    if (parsedOutput.success && parsedOutput.oldContent && parsedOutput.newContent) {
      return (
        <RichDiffRenderer
          title={(parsedOutput.title as string | undefined) || 'Modified Document'}
          oldContent={parsedOutput.oldContent as string}
          newContent={parsedOutput.newContent as string}
          pageId={parsedOutput.pageId as string | undefined}
          changeSummary={parsedOutput.summary as string | undefined}
          maxHeight={maxHeight}
        />
      );
    }
    if (parsedOutput.success && parsedOutput.newContent) {
      return (
        <RichContentRenderer
          title={(parsedOutput.title as string | undefined) || 'Modified Document'}
          content={parsedOutput.newContent as string}
          pageId={parsedOutput.pageId as string | undefined}
          pageType={parsedOutput.type as string | undefined}
          maxHeight={maxHeight}
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

  // === CHANNEL TOOLS ===
  if (toolName === 'send_channel_message') {
    const messagePreview = getSendChannelMessagePreview(parsedInput, parsedOutput);
    const channelTitle = parsedOutput.channelTitle;
    const previewTitle = typeof channelTitle === 'string' && channelTitle.length > 0
      ? `Message Preview · #${channelTitle}`
      : 'Message Preview';

    return (
      <div>
        <ActionResultRenderer
          actionType="update"
          success={parsedOutput.success !== false}
          title={channelTitle as string | undefined}
          pageId={parsedOutput.channelId as string | undefined}
          pageType="CHANNEL"
          message={(parsedOutput.summary || parsedOutput.message) as string | undefined}
          errorMessage={parsedOutput.error as string | undefined}
        />
        {messagePreview && (
          <RichContentRenderer
            title={previewTitle}
            content={messagePreview}
            pageId={parsedOutput.channelId as string | undefined}
            pageType="CHANNEL"
            maxHeight={compact ? 160 : 220}
          />
        )}
      </div>
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

  if (toolName === 'ask_agent' && parsedOutput.response) {
    return (
      <RichContentRenderer
        title="Agent Response"
        content={String(parsedOutput.response)}
        maxHeight={maxHeight}
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
  if (toolName === 'get_activity') {
    if (parsedOutput.activities) {
      return (
        <ActivityRenderer
          activities={parsedOutput.activities as ActivityItem[]}
          period={parsedOutput.period as string | undefined}
        />
      );
    }
    if (parsedOutput.drives && Array.isArray(parsedOutput.drives)) {
      const actors = (parsedOutput.actors || []) as Array<{ email: string; name: string | null; isYou: boolean; count: number }>;
      const driveGroups = parsedOutput.drives as Array<{
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

      const meta = parsedOutput.meta as { window?: string } | undefined;
      const period = meta?.window ? `Last ${meta.window}` : undefined;

      return <ActivityRenderer activities={flatActivities} period={period} />;
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
        maxHeight={maxHeight}
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

  return null;
};

// Compact inline renderer
const CompactToolRenderer: React.FC<{ part: ToolPart; toolName: string }> = memo(function CompactToolRenderer({ part, toolName }) {
  const [isExpanded, setIsExpanded] = useState(false);

  const state = part.state;
  const input = part.input;
  const output = part.output;
  const error = part.errorText;

  const parsedInput = useMemo(() => safeJsonParse(input), [input]);
  const parsedOutput = useMemo(() => safeJsonParse(output), [output]);

  const formattedToolName = useMemo(() => {
    return TOOL_NAME_MAP[toolName] || toolName
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }, [toolName]);

  const descriptiveTitle = useMemo(() => {
    if (!parsedInput) return formattedToolName;
    const params = parsedInput;

    if (['read_page', 'replace_lines', 'list_pages'].includes(toolName)) {
      if (params.title) return `${formattedToolName}: "${params.title}"`;
      if (params.dir) return `${formattedToolName}: ${params.dir}`;
    }

    if (['create_page', 'move_page'].includes(toolName)) {
      if (params.title) return `${formattedToolName}: "${params.title}"`;
      if (params.name) return `${formattedToolName}: "${params.name}"`;
    }

    if (toolName === 'rename_page') {
      if (params.currentTitle) return `${formattedToolName}: "${params.currentTitle}"`;
    }

    if (['trash', 'restore'].includes(toolName)) {
      if (params.title || params.name) return `${formattedToolName}: "${params.title || params.name}"`;
    }

    if (['list_pages', 'list_trash'].includes(toolName)) {
      if (params.driveSlug) return `${formattedToolName}: "${params.driveSlug}"`;
    }

    if (toolName === 'create_drive' || toolName === 'rename_drive') {
      if (params.name || params.currentName) return `${formattedToolName}: "${params.name || params.currentName}"`;
    }

    return formattedToolName;
  }, [parsedInput, formattedToolName, toolName]);

  const compactSummary = useMemo(() => getCompactSummary(toolName, state, error, parsedInput, parsedOutput), [toolName, state, error, parsedInput, parsedOutput]);

  const richContent = useMemo(() => buildRichContent(toolName, parsedInput, parsedOutput, error, true), [toolName, parsedInput, parsedOutput, error]);

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
        <div className="flex-shrink-0">{getToolIcon(toolName, "h-3 w-3")}</div>
        <span className="font-medium truncate flex-1 min-w-0" title={descriptiveTitle}>{descriptiveTitle}</span>
        <div className="flex-shrink-0">{getStatusIcon(state, error, "h-3 w-3")}</div>
        <span className="text-gray-500 dark:text-gray-400 truncate max-w-[80px] min-w-0">
          {compactSummary}
        </span>
      </button>

      {expandedDetails}
    </div>
  );
});

// Full Tool card renderer
const FullToolRenderer: React.FC<{ part: ToolPart; toolName: string }> = memo(function FullToolRenderer({ part, toolName }) {
  const state = part.state || 'input-available';
  const input = part.input;
  const output = part.output;
  const error = part.errorText;

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

  const parsedInput = useMemo(() => safeJsonParseWithRaw(input), [input]);
  const parsedOutput = useMemo(() => {
    if (output == null) return null;
    return safeJsonParseWithRaw(output);
  }, [output]);

  const formattedToolName = useMemo(() => {
    return TOOL_NAME_MAP[toolName] || toolName.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }, [toolName]);

  const descriptiveTitle = useMemo(() => {
    if (!parsedInput) return formattedToolName;
    const params = parsedInput as Record<string, unknown>;

    if (params.title && typeof params.title === 'string') return `${formattedToolName}: ${params.title}`;
    if (params.name && typeof params.name === 'string') return `${formattedToolName}: ${params.name}`;
    if (params.query && typeof params.query === 'string') {
      const truncated = params.query.length > 30 ? params.query.slice(0, 30) + '...' : params.query;
      return `${formattedToolName}: ${truncated}`;
    }
    if (params.pattern && typeof params.pattern === 'string') return `${formattedToolName}: ${params.pattern}`;
    if (params.driveSlug && typeof params.driveSlug === 'string') return `${formattedToolName}: ${params.driveSlug}`;

    return formattedToolName;
  }, [parsedInput, formattedToolName]);

  const richContent = useMemo(() => buildRichContent(toolName, parsedInput, parsedOutput, error, false), [toolName, parsedInput, parsedOutput, error]);

  return (
    <Tool className="my-2">
      <ToolHeader
        title={descriptiveTitle}
        type={`tool-${toolName}`}
        state={toolState}
      />
      <ToolContent>
        {richContent || (
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

export const ToolCallRenderer: React.FC<ToolCallRendererProps> = memo(function ToolCallRenderer({ part, compact = false }) {
  const toolName = part.toolName || part.type?.replace('tool-', '') || 'unknown_tool';

  // Task management - has its own dedicated renderer
  if (toolName === 'update_task') {
    return <TaskRenderer part={part} />;
  }

  // Ask Agent - has its own conversation UI (only for full mode)
  if (toolName === 'ask_agent' && !compact) {
    return <PageAgentConversationRenderer part={part} />;
  }

  // Use compact or full renderer based on prop
  if (compact) {
    return <CompactToolRenderer part={part} toolName={toolName} />;
  }

  return <FullToolRenderer part={part} toolName={toolName} />;
});
