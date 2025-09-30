import React from 'react';
import { PageType, isFolderPage } from '@pagespace/lib/client-safe';
import { 
  FileText, 
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
  FileUp,
  FileDown,
  Bot
} from 'lucide-react';
import { Task, TaskTrigger, TaskContent, TaskItem, TaskItemFile, TaskStatus } from '@/components/ai/task';
import { TaskManagementToolRenderer } from './TaskManagementToolRenderer';
import { AgentConversationRenderer } from './AgentConversationRenderer';

interface DriveInfo {
  slug: string;
  title: string;
  description: string;
  isDefault: boolean;
}

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

interface ToolCallRendererProps {
  part: ToolPart;
}

/**
 * Renders PageSpace tool calls using Task pattern for better organization
 */
export const ToolCallRenderer: React.FC<ToolCallRendererProps> = ({ part }) => {
  const toolName = part.toolName || part.type?.replace('tool-', '');
  const state = part.state;
  const input = part.input;
  const output = part.output;
  const error = part.errorText;

  // Task management tools - render with TodoListMessage components
  const taskManagementTools = [
    'create_task_list',
    'update_task_status', 
    'add_task',
    'get_task_list',
    'resume_task_list',
    'add_task_note'
  ];

  if (taskManagementTools.includes(toolName)) {
    return (
      <TaskManagementToolRenderer 
        part={part} 
        onTaskUpdate={async (taskId: string, newStatus) => {
          // Update task status via API
          try {
            await fetch(`/api/ai/tasks/${taskId}/status`, {
              method: 'PATCH',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ status: newStatus }),
            });
          } catch (error) {
            console.error('Error updating task:', error);
          }
        }}
      />
    );
  }

  // Ask Agent tool - render with dedicated conversation UI
  if (toolName === 'ask_agent') {
    return <AgentConversationRenderer part={part} />;
  }

  // Convert AI SDK state to Task status
  const getTaskStatus = (): TaskStatus => {
    switch (state) {
      case 'output-available':
      case 'done':
        return error ? 'error' : 'completed';
      case 'input-available':
      case 'streaming':
        return 'in_progress';
      case 'output-error':
        return 'error';
      default:
        return 'pending';
    }
  };

  // Tool-specific icons
  const getToolIcon = (toolName: string) => {
    switch (toolName) {
      case 'ask_agent':
        return <Bot className="h-4 w-4" />;
      case 'list_drives':
        return <Database className="h-4 w-4" />;
      case 'list_pages':
        return <FolderOpen className="h-4 w-4" />;
      case 'read_page':
        return <Eye className="h-4 w-4" />;
      case 'replace_lines':
      case 'insert_lines':
      case 'delete_lines':
        return <Edit className="h-4 w-4" />;
      case 'append_to_page':
        return <FileDown className="h-4 w-4" />;
      case 'prepend_to_page':
        return <FileUp className="h-4 w-4" />;
      case 'create_page':
        return <Plus className="h-4 w-4" />;
      case 'rename_page':
        return <FilePlus className="h-4 w-4" />;
      case 'trash_page':
      case 'trash_page_with_children':
        return <Trash className="h-4 w-4" />;
      case 'restore_page':
        return <RotateCcw className="h-4 w-4" />;
      case 'move_page':
        return <Move className="h-4 w-4" />;
      case 'list_trash':
        return <Trash className="h-4 w-4" />;
      default:
        return <Search className="h-4 w-4" />;
    }
  };

  // Format tool name for display
  const formatToolName = (toolName: string) => {
    const nameMap: Record<string, string> = {
      'ask_agent': 'Ask Agent',
      'list_drives': 'List Drives',
      'list_pages': 'List Pages',
      'read_page': 'Read Page',
      'replace_lines': 'Replace Lines',
      'insert_lines': 'Insert Lines',
      'delete_lines': 'Delete Lines',
      'append_to_page': 'Append to Page',
      'prepend_to_page': 'Prepend to Page',
      'create_page': 'Create Page',
      'rename_page': 'Rename Page',
      'trash_page': 'Trash Page',
      'trash_page_with_children': 'Trash Page & Children',
      'restore_page': 'Restore Page',
      'move_page': 'Move Page',
      'list_trash': 'List Trash'
    };
    
    return nameMap[toolName] || toolName
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  };


  const taskStatus = getTaskStatus();

  // Get enhanced task title with result message
  const getTaskTitle = (): string => {
    const baseTitle = formatToolName(toolName);
    
    // For pending state, just show tool name
    if (taskStatus === 'pending') {
      return baseTitle;
    }
    
    // For in-progress state, show executing
    if (taskStatus === 'in_progress') {
      return `${baseTitle}: Executing...`;
    }
    
    // For error state, use error message
    if (taskStatus === 'error' && error) {
      // Truncate very long error messages for the title
      const truncatedError = error.length > 60 ? error.substring(0, 57) + '...' : error;
      return `${baseTitle}: Failed - ${truncatedError}`;
    }
    
    // For completed state, try to extract meaningful message from output
    if (taskStatus === 'completed' && output) {
      try {
        const result = typeof output === 'string' ? JSON.parse(output) : output;
        
        // Handle different tool types
        if (toolName === 'list_drives' && result.drives) {
          return `${baseTitle}: Found ${result.drives.length} drive${result.drives.length === 1 ? '' : 's'}`;
        }
        
        if (toolName === 'list_pages' && result.tree) {
          const pageCount = countPages(result.tree || []);
          return `${baseTitle}: Found ${pageCount} page${pageCount === 1 ? '' : 's'}`;
        }
        
        if (toolName === 'read_page') {
          const title = result.title || result.path || 'document';
          const lines = result.lineCount ? ` (${result.lineCount} lines)` : '';
          return `${baseTitle}: Read "${title}"${lines}`;
        }
        
        // For edit and page management operations, use the message
        if (result.message) {
          // Truncate very long messages for the title
          const truncatedMessage = result.message.length > 80 ? result.message.substring(0, 77) + '...' : result.message;
          return `${baseTitle}: ${truncatedMessage}`;
        }
        
        // For page operations with title
        if (['create_page', 'rename_page'].includes(toolName) && result.title) {
          const action = toolName === 'create_page' ? 'Created' : 'Renamed to';
          return `${baseTitle}: ${action} "${result.title}"`;
        }
        
        // For trash operations
        if (['trash_page', 'trash_page_with_children'].includes(toolName) && result.title) {
          return `${baseTitle}: Moved "${result.title}" to trash`;
        }
        
        // For restore operations
        if (toolName === 'restore_page' && result.title) {
          return `${baseTitle}: Restored "${result.title}"`;
        }
        
        // For move operations
        if (toolName === 'move_page' && result.title) {
          return `${baseTitle}: Moved "${result.title}"`;
        }
        
      } catch {
        // If parsing fails, fall back to base title
      }
    }
    
    // Fallback to base title
    return baseTitle;
  };

  // Helper function to count pages in tree structure
  const countPages = (items: TreeItem[]): number => {
    return items.reduce((count, item) => {
      return count + 1 + (item.children ? countPages(item.children) : 0);
    }, 0);
  };

  // Render tool parameters if available
  const renderParameters = () => {
    if (!input) return null;
    
    try {
      const params = typeof input === 'string' ? JSON.parse(input) : input;
      return (
        <div className="mt-2 p-2 bg-muted rounded text-xs">
          <div className="font-medium text-gray-700 dark:text-gray-300 mb-1">Parameters:</div>
          <pre className="text-gray-600 dark:text-gray-400 overflow-x-auto">
            {JSON.stringify(params, null, 2)}
          </pre>
        </div>
      );
    } catch {
      return null;
    }
  };

  // Render tool output
  const renderOutput = () => {
    if (!output) return null;

    try {
      const result = typeof output === 'string' ? JSON.parse(output) : output;
      
      // Handle different output types
      if (toolName === 'list_drives' && result.drives) {
        return (
          <div className="space-y-1">
            <div className="text-xs font-medium text-gray-700 dark:text-gray-300">Found drives:</div>
            {result.drives.map((drive: DriveInfo, index: number) => (
              <TaskItem key={index} status="completed">
                <TaskItemFile>{drive.title}</TaskItemFile>
                {drive.description && (
                  <span className="text-gray-500"> - {drive.description}</span>
                )}
              </TaskItem>
            ))}
          </div>
        );
      }

      if (toolName === 'list_pages' && result.tree) {
        return (
          <div className="space-y-1">
            <div className="text-xs font-medium text-gray-700 dark:text-gray-300">Page structure:</div>
            {renderTreeItems(result.tree || [])}
          </div>
        );
      }

      if (toolName === 'read_page' && result.content) {
        return (
          <div className="space-y-1">
            <TaskItem status="completed">
              Read <TaskItemFile>{result.title || result.path}</TaskItemFile>
            </TaskItem>
            <div className="text-xs text-gray-500">
              {result.lineCount} lines • {result.type?.toLowerCase()}
            </div>
            {result.content && (
              <div className="mt-2 p-2 bg-muted rounded text-xs max-h-32 overflow-y-auto">
                <pre className="text-gray-600 dark:text-gray-400 whitespace-pre-wrap">
                  {result.content.slice(0, 500)}{result.content.length > 500 ? '...' : ''}
                </pre>
              </div>
            )}
          </div>
        );
      }

      if (['replace_lines', 'insert_lines', 'delete_lines', 'append_to_page', 'prepend_to_page'].includes(toolName)) {
        return (
          <TaskItem status="completed">
            {result.message || `Successfully completed ${formatToolName(toolName).toLowerCase()}`}
            {result.title && (
              <span> on <TaskItemFile>{result.title}</TaskItemFile></span>
            )}
          </TaskItem>
        );
      }

      if (['create_page', 'rename_page', 'trash_page', 'trash_page_with_children', 'restore_page', 'move_page'].includes(toolName)) {
        return (
          <TaskItem status="completed">
            {result.message || `Successfully completed ${formatToolName(toolName).toLowerCase()}`}
            {result.title && (
              <span>: <TaskItemFile>{result.title}</TaskItemFile></span>
            )}
          </TaskItem>
        );
      }

      // Generic output for other tools
      return (
        <div className="mt-2 p-2 bg-muted rounded text-xs">
          <div className="font-medium text-gray-700 dark:text-gray-300 mb-1">Result:</div>
          <pre className="text-gray-600 dark:text-gray-400 overflow-x-auto whitespace-pre-wrap">
            {JSON.stringify(result, null, 2)}
          </pre>
        </div>
      );
    } catch {
      return (
        <div className="mt-2 p-2 bg-muted rounded text-xs">
          <pre className="text-gray-600 dark:text-gray-400 overflow-x-auto whitespace-pre-wrap">
            {typeof output === 'string' ? output : JSON.stringify(output, null, 2)}
          </pre>
        </div>
      );
    }
  };

  // Helper function to render tree items
  const renderTreeItems = (items: TreeItem[], depth = 0): React.ReactNode => {
    return items.map((item, index) => (
      <div key={index} style={{ paddingLeft: `${depth * 12}px` }}>
        <TaskItem status="completed">
          {isFolderPage(item.type as PageType) ? (
            <FolderOpen className="h-3 w-3 text-primary" />
          ) : (
            <FileText className="h-3 w-3 text-gray-600" />
          )}
          <span className="text-xs">{item.title}</span>
        </TaskItem>
        {item.children?.length > 0 && renderTreeItems(item.children, depth + 1)}
      </div>
    ));
  };

  // Render error if present
  const renderError = () => {
    if (!error) return null;
    
    return (
      <div className="mt-2 p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-xs">
        <div className="font-medium text-red-700 dark:text-red-300 mb-1">Error:</div>
        <div className="text-red-600 dark:text-red-400">{error}</div>
      </div>
    );
  };

  return (
    <Task defaultOpen={taskStatus === 'in_progress' || taskStatus === 'error'} className="my-2">
      <TaskTrigger
        title={getTaskTitle()}
        status={taskStatus}
        icon={getToolIcon(toolName)}
      />
      <TaskContent>
        <TaskItem status={taskStatus}>
          {taskStatus === 'in_progress' && 'Executing...'}
          {taskStatus === 'completed' && 'Completed successfully'}
          {taskStatus === 'error' && 'Failed'}
          {taskStatus === 'pending' && 'Waiting to execute...'}
        </TaskItem>
        
        {renderParameters()}
        {renderOutput()}
        {renderError()}
      </TaskContent>
    </Task>
  );
};
