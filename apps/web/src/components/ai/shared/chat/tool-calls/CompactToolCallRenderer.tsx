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

import { type TreeItem } from './PageTreeRenderer';
import { TaskRenderer } from './TaskRenderer';
import { TASK_TOOL_NAMES } from '../useAggregatedTasks';
import { PageAgentConversationRenderer } from '@/components/ai/page-agents';
import { renderToolContent } from './registry';
import { isHiddenTool } from './tool-significance';
import { parseIntegrationToolName, isIntegrationTool } from '@pagespace/lib/integrations/converter/ai-sdk';
import { getBuiltinProvider } from '@pagespace/lib/integrations/providers/builtin-providers';

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
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}

// Count pages in a tree structure (used by the compact one-line summary)
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

// Compact one-line preview for send_channel_message
const getSendChannelMessagePreview = (
  parsedInput: Record<string, unknown> | null,
  parsedOutput: Record<string, unknown>
): string | null => {
  const outputPreview = parsedOutput.messagePreview;
  if (typeof outputPreview === 'string' && outputPreview.trim().length > 0) {
    return outputPreview.trim();
  }

  const inputContent = parsedInput?.content;
  if (typeof inputContent === 'string' && inputContent.trim().length > 0) {
    return inputContent.trim();
  }

  return null;
};

// Tool name mapping (moved outside component to avoid recreation)
export const TOOL_NAME_MAP: Record<string, string> = {
  'ask_agent': 'Ask Agent',
  'list_drives': 'List Drives',
  'list_pages': 'List Pages',
  'read_page': 'Read',
  'replace_lines': 'Replace',
  'insert_content': 'Insert',
  'create_page': 'Create',
  'rename_page': 'Rename',
  'send_channel_message': 'Send Message',
  'trash_page': 'Trash',
  'trash_drive': 'Trash Drive',
  'restore_page': 'Restore',
  'restore_drive': 'Restore Drive',
  'move_page': 'Move',
  'list_trash': 'List Trash'
};

// Internal renderer component with hooks
const CompactToolCallRendererInternal: React.FC<{ part: ToolPart; toolName: string; expanded?: boolean; onExpandedChange?: (expanded: boolean) => void }> = memo(function CompactToolCallRendererInternal({ part, toolName, expanded: expandedProp, onExpandedChange }) {
  const [internalExpanded, setInternalExpanded] = useState(false);
  const isExpanded = expandedProp ?? internalExpanded;
  const toggleExpanded = () => {
    const next = !isExpanded;
    onExpandedChange?.(next);
    if (expandedProp === undefined) setInternalExpanded(next);
  };

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
      case 'send_channel_message':
        return <MessageSquare className={iconClass} />;
      case 'replace_lines':
      case 'insert_content':
        return <Edit className={iconClass} />;
      case 'create_page':
        return <Plus className={iconClass} />;
      case 'rename_page':
        return <FilePlus className={iconClass} />;
      case 'trash_page':
      case 'trash_drive':
        return <Trash className={iconClass} />;
      case 'restore_page':
      case 'restore_drive':
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
    if (isIntegrationTool(toolName)) {
      const parsed = parseIntegrationToolName(toolName);
      if (parsed) {
        const provider = getBuiltinProvider(parsed.providerSlug);
        const tool = provider?.tools.find(t => t.id === parsed.toolId);
        if (tool) return tool.name;
        return parsed.toolId.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      }
    }
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
    if (['read_page', 'replace_lines', 'insert_content', 'list_pages'].includes(toolName)) {
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

    // Trash/Restore (per-entity verb tools)
    if (['trash_page', 'trash_drive', 'restore_page', 'restore_drive'].includes(toolName)) {
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

      if (toolName === 'list_pages') {
        if (result.count !== undefined) return `${result.count} pages`;
        if (result.tree) {
          const pageCount = countPages((result.tree as TreeItem[]) || []);
          return `${pageCount} pages`;
        }
      }

      if (toolName === 'read_page') {
        const title = (result.title as string) || 'page';
        return title.length > 20 ? title.substring(0, 17) + '...' : title;
      }

      if (toolName === 'send_channel_message') {
        const preview = getSendChannelMessagePreview(parsedInput, result);
        if (preview) {
          return preview.length > 30 ? preview.substring(0, 27) + '...' : preview;
        }
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
  }, [error, state, parsedInput, parsedOutput, toolName]);

  // Expanded details — delegate the rich body to the shared tool renderer
  // registry so compact has full parity with the main transcript.
  const expandedDetails = useMemo(() => {
    if (!isExpanded) return null;

    const richContent = renderToolContent({ toolName, parsedInput, parsedOutput, output, error });

    return (
      <div className="mt-1 max-w-full break-words">
        {richContent ? (
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
  }, [isExpanded, toolName, parsedInput, parsedOutput, output, error, state]);

  return (
    <div className="py-0.5 text-[11px] max-w-full">
      <button
        onClick={toggleExpanded}
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

export const CompactToolCallRenderer: React.FC<CompactToolCallRendererProps> = memo(function CompactToolCallRenderer({ part, expanded, onExpandedChange }) {
  let toolName = part.toolName || part.type?.replace('tool-', '') || '';
  let resolvedPart = part;

  if (isHiddenTool(toolName)) return null;

  if (toolName === 'execute_tool') {
    const raw = safeJsonParse(part.input);
    const innerName = typeof raw?.tool_name === 'string' ? raw.tool_name : null;
    if (innerName) {
      toolName = innerName;
      resolvedPart = { ...part, input: raw?.parameters ?? {} };
    }
  }

  if (isHiddenTool(toolName)) return null;

  if (TASK_TOOL_NAMES.has(toolName)) return <TaskRenderer part={resolvedPart} />;
  if (toolName === 'ask_agent') return <PageAgentConversationRenderer part={resolvedPart} />;
  return <CompactToolCallRendererInternal part={resolvedPart} toolName={toolName} expanded={expanded} onExpandedChange={onExpandedChange} />;
});
