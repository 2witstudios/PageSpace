import React, { useState } from 'react';
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
import { CompactTaskManagementToolRenderer } from './CompactTaskManagementToolRenderer';
import { patch } from '@/lib/auth-fetch';


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

/**
 * Compact tool call renderer for sidebar - minimal and space-efficient
 */
export const CompactToolCallRenderer: React.FC<CompactToolCallRendererProps> = ({ part }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  
  const toolName = part.toolName || part.type?.replace('tool-', '');
  const state = part.state;
  const input = part.input;
  const output = part.output;
  const error = part.errorText;

  // Task management tools - render with CompactTodoListMessage components
  const taskManagementTools = [
    'create_task_list',
    'update_task_status',
    'add_task',
    'get_task_list',
    'resume_task_list'
  ];

  if (taskManagementTools.includes(toolName)) {
    return (
      <CompactTaskManagementToolRenderer
        part={part}
        onTaskUpdate={async (taskId: string, newStatus) => {
          // Update task status via API
          try {
            await patch(`/api/ai/tasks/${taskId}/status`, { status: newStatus });
          } catch (error) {
            console.error('Error updating task:', error);
          }
        }}
      />
    );
  }

  // Tool-specific icons (smaller)
  const getToolIcon = (toolName: string) => {
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
      case 'insert_lines':
        return <Edit className={iconClass} />;
      case 'create_page':
        return <Plus className={iconClass} />;
      case 'rename_page':
        return <FilePlus className={iconClass} />;
      case 'trash_page':
        return <Trash className={iconClass} />;
      case 'restore_page':
        return <RotateCcw className={iconClass} />;
      case 'move_page':
        return <Move className={iconClass} />;
      case 'list_trash':
        return <Trash className={iconClass} />;
      default:
        return <Search className={iconClass} />;
    }
  };

  // Get status icon
  const getStatusIcon = () => {
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
  };

  // Format tool name for display (shorter)
  const formatToolName = (toolName: string) => {
    const nameMap: Record<string, string> = {
      'ask_agent': 'Ask Agent',
      'list_drives': 'List Drives',
      'list_pages': 'List Pages',
      'read_page': 'Read',
      'replace_lines': 'Replace',
      'insert_lines': 'Insert',
      'create_page': 'Create',
      'rename_page': 'Rename',
      'trash_page': 'Trash',
      'restore_page': 'Restore',
      'move_page': 'Move',
      'list_trash': 'List Trash'
    };
    
    return nameMap[toolName] || toolName
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  };

  // Get compact summary
  const getCompactSummary = (): string => {
    if (error) return 'Failed';
    
    if (state === 'output-available' || state === 'done') {
      try {
        const result = typeof output === 'string' ? JSON.parse(output) : output;
        
        if (toolName === 'ask_agent' && result.response) {
          const text = String(result.response);
          return text.length > 30 ? text.substring(0, 27) + '...' : text;
        }

        // Very compact summaries
        if (toolName === 'list_drives' && result.drives) {
          return `${result.drives.length} drives`;
        }
        
        if (toolName === 'list_pages' && result.tree) {
          const pageCount = countPages(result.tree || []);
          return `${pageCount} pages`;
        }
        
        if (toolName === 'read_page') {
          const title = result.title || 'page';
          return title.length > 20 ? title.substring(0, 17) + '...' : title;
        }
        
        if (result.message) {
          const msg = result.message;
          return msg.length > 30 ? msg.substring(0, 27) + '...' : msg;
        }
        
        if (result.title) {
          return result.title.length > 20 ? result.title.substring(0, 17) + '...' : result.title;
        }
        
        return 'Complete';
      } catch {
        return 'Done';
      }
    }
    
    if (state === 'input-available' || state === 'streaming') {
      return 'Running...';
    }
    
    return 'Pending';
  };

  // Helper function to count pages in tree structure
  const countPages = (items: TreeItem[]): number => {
    return items.reduce((count, item) => {
      return count + 1 + (item.children ? countPages(item.children) : 0);
    }, 0);
  };

  // Render compact details when expanded
  const renderExpandedDetails = () => {
    if (!isExpanded) return null;

    return (
      <div className="mt-1 p-1.5 bg-gray-50 dark:bg-gray-800/50 rounded text-[10px] space-y-1 max-w-full overflow-hidden">
        {input ? (
          <div className="space-y-0.5 max-w-full overflow-hidden">
            <div className="font-medium text-gray-600 dark:text-gray-400">Input:</div>
            <pre className="text-gray-500 dark:text-gray-500 overflow-x-auto whitespace-pre-wrap break-all max-w-full">
              {JSON.stringify(typeof input === 'string' ? JSON.parse(input) : input, null, 2)}
            </pre>
          </div>
        ) : null}

        {output ? (
          <div className="space-y-0.5 max-w-full overflow-hidden">
            <div className="font-medium text-gray-600 dark:text-gray-400">Output:</div>
            <pre className="text-gray-500 dark:text-gray-500 overflow-x-auto whitespace-pre-wrap break-all max-h-32 overflow-y-auto max-w-full">
              {(() => {
                try {
                  const result = typeof output === 'string' ? JSON.parse(output) : output;

                  // Special handling for read_page content
                  if (toolName === 'read_page' && result.content) {
                    return result.content.slice(0, 200) + (result.content.length > 200 ? '...' : '');
                  }

                  return JSON.stringify(result, null, 2);
                } catch {
                  return typeof output === 'string' ? output : JSON.stringify(output, null, 2);
                }
              })()}
            </pre>
          </div>
        ) : null}

        {error ? (
          <div className="p-1 bg-red-50 dark:bg-red-900/20 rounded max-w-full overflow-hidden">
            <div className="text-red-600 dark:text-red-400 break-words">{error}</div>
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="bg-gray-50 dark:bg-gray-800/30 rounded p-1.5 text-[11px] max-w-full overflow-hidden">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center space-x-1.5 text-left hover:bg-gray-100 dark:hover:bg-gray-700/30 rounded p-0.5 transition-colors max-w-full overflow-hidden"
      >
        {isExpanded ? <ChevronDown className="h-3 w-3 flex-shrink-0" /> : <ChevronRight className="h-3 w-3 flex-shrink-0" />}
        <div className="flex-shrink-0">{getToolIcon(toolName)}</div>
        <span className="font-medium truncate flex-1 min-w-0">{formatToolName(toolName)}</span>
        <div className="flex-shrink-0">{getStatusIcon()}</div>
        <span className="text-gray-500 dark:text-gray-400 truncate max-w-[80px] min-w-0">
          {getCompactSummary()}
        </span>
      </button>

      {renderExpandedDetails()}
    </div>
  );
};
