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

import { FileTreeRenderer } from './FileTreeRenderer';
import { RichContentRenderer } from './RichContentRenderer';
import { RichDiffRenderer } from './RichDiffRenderer';
import { TaskRenderer } from './TaskRenderer';

interface TreeItem {
  path: string;
  title: string;
  type: string;
  children: TreeItem[];
}

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

  // Memoize stringified input for display
  const inputDisplay = useMemo(() => {
    if (!parsedInput) return null;
    try {
      return JSON.stringify(parsedInput, null, 2);
    } catch {
      return String(input);
    }
  }, [parsedInput, input]);

  // Memoize expanded details content
  const expandedDetails = useMemo(() => {
    if (!isExpanded) return null;

    const result = parsedOutput as Record<string, unknown> | null;

    return (
      <div className="mt-1 p-1.5 bg-gray-50 dark:bg-gray-800/50 rounded text-[10px] space-y-1 max-w-full break-words">
        {inputDisplay ? (
          <div className="space-y-0.5 max-w-full break-words">
            <div className="font-medium text-gray-600 dark:text-gray-400">Input:</div>
            <pre className="text-gray-500 dark:text-gray-500 overflow-x-auto whitespace-pre-wrap break-all max-w-full">
              {inputDisplay}
            </pre>
          </div>
        ) : null}

        {output ? (
          <div className="space-y-0.5 max-w-full break-words">
            <div className="font-medium text-gray-600 dark:text-gray-400">Result:</div>
            {(() => {
              if (result) {
                if (toolName === 'list_pages' && result.tree) {
                  return <div className="border rounded-md overflow-hidden"><FileTreeRenderer tree={result.tree as TreeItem[]} /></div>;
                }

                if (toolName === 'read_page' && (result.rawContent || result.content)) {
                  return (
                    <div className="border rounded-md overflow-hidden">
                      <RichContentRenderer
                        title={(result.title as string) || 'Document'}
                        content={(result.rawContent as string) || (result.content as string)}
                        pageId={result.pageId as string | undefined}
                        pageType={result.type as string | undefined}
                        maxHeight={200}
                      />
                    </div>
                  );
                }

                if (toolName === 'replace_lines' && result.success) {
                  // Show diff if both old and new content available
                  if (result.oldContent && result.newContent) {
                    return (
                      <div className="border rounded-md overflow-hidden">
                        <RichDiffRenderer
                          title={(result.title as string) || 'Modified Document'}
                          oldContent={result.oldContent as string}
                          newContent={result.newContent as string}
                          pageId={result.pageId as string | undefined}
                          changeSummary={result.summary as string | undefined}
                          maxHeight={200}
                        />
                      </div>
                    );
                  }
                  // Fallback to showing new content
                  if (result.newContent) {
                    return (
                      <div className="border rounded-md overflow-hidden">
                        <RichContentRenderer
                          title={(result.title as string) || 'Modified Document'}
                          content={result.newContent as string}
                          pageId={result.pageId as string | undefined}
                          pageType={result.type as string | undefined}
                          maxHeight={200}
                        />
                      </div>
                    );
                  }
                }

                return (
                  <pre className="text-gray-500 dark:text-gray-500 overflow-x-auto whitespace-pre-wrap break-all max-h-60 overflow-y-auto max-w-full">
                    {JSON.stringify(result, null, 2)}
                  </pre>
                );
              }

              return (
                <pre className="text-gray-500 dark:text-gray-500 overflow-x-auto whitespace-pre-wrap break-all max-h-32 overflow-y-auto max-w-full">
                  {typeof output === 'string' ? output : JSON.stringify(output, null, 2)}
                </pre>
              );
            })()}
          </div>
        ) : null}

        {error ? (
          <div className="p-1 bg-red-50 dark:bg-red-900/20 rounded max-w-full break-words">
            <div className="text-red-600 dark:text-red-400 break-words">{error}</div>
          </div>
        ) : null}
      </div>
    );
  }, [isExpanded, inputDisplay, output, parsedOutput, toolName, error]);

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
