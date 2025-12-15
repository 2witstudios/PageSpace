import React, { useMemo, useState, useEffect } from 'react';
import { UIMessage } from 'ai';
import { CompactToolCallRenderer } from '@/components/ai/tools/CompactToolCallRenderer';
import { CompactGroupedToolCallsRenderer } from '@/components/ai/tools/CompactGroupedToolCallsRenderer';
import { StreamingMarkdown } from './StreamingMarkdown';
import { MessageActionButtons } from './MessageActionButtons';
import { MessageEditor } from './MessageEditor';
import { DeleteMessageDialog } from './DeleteMessageDialog';
import { CompactTodoListMessage } from './CompactTodoListMessage';
import { useSocket } from '@/hooks/useSocket';
import { ErrorBoundary } from '@/components/ai/shared/ErrorBoundary';
import { patch, fetchWithAuth } from '@/lib/auth/auth-fetch';
import styles from './CompactMessageRenderer.module.css';

// Extended message interface that includes database fields
interface ConversationMessage extends UIMessage {
  messageType?: 'standard' | 'todo_list';
  conversationId?: string;
  isActive?: boolean;
  editedAt?: Date;
  createdAt?: Date;
}

interface TextPart {
  type: 'text';
  text: string;
}

interface ToolPart {
  type: string; // "tool-{toolName}"
  toolCallId: string;
  toolName: string;
  input?: Record<string, unknown>;
  output?: unknown;
  state: 'input-streaming' | 'input-available' | 'output-available' | 'output-error';
}

interface TextGroupPart {
  type: 'text-group';
  parts: TextPart[];
}

interface ToolGroupPart {
  type: string; // "tool-{toolName}"
  toolCallId: string;
  toolName: string;
  input?: Record<string, unknown>;
  output?: unknown;
  state: 'input-streaming' | 'input-available' | 'output-available' | 'output-error' | 'done' | 'streaming';
}

interface ToolCallsGroupPart {
  type: 'tool-calls-group';
  tools: ToolGroupPart[];
}

type GroupedPart = TextGroupPart | ToolGroupPart | ToolCallsGroupPart;

interface CompactTextBlockProps {
  parts: TextPart[];
  role: 'user' | 'assistant' | 'system';
  messageId: string;
  createdAt?: Date;
  editedAt?: Date | null;
  onEdit?: () => void;
  onDelete?: () => void;
  onRetry?: () => void;
  isEditing?: boolean;
  onSaveEdit?: (newContent: string) => Promise<void>;
  onCancelEdit?: () => void;
  /** Whether this message is currently being streamed (for progressive markdown rendering) */
  isStreaming?: boolean;
}

/**
 * Compact text block for sidebar - minimal margins and padding
 * Memoized to prevent unnecessary re-renders during streaming
 */
const CompactTextBlock: React.FC<CompactTextBlockProps> = React.memo(({
  parts,
  role,
  messageId,
  createdAt,
  editedAt,
  onEdit,
  onDelete,
  onRetry,
  isEditing,
  onSaveEdit,
  onCancelEdit,
  isStreaming = false
}) => {
  const content = parts.map(part => part.text).join('');

  if (!content.trim() && !isEditing) return null;

  return (
    <div
      className={`group relative p-2 rounded-md text-xs ${role === 'user'
          ? 'bg-primary/10 dark:bg-accent/20 ml-2'
          : 'bg-gray-50 dark:bg-gray-800/50'
        }`}
    >
      <div className="flex items-center justify-between mb-0.5">
        <div className={`text-xs font-medium ${role === 'user' ? 'text-primary dark:text-primary' : 'text-gray-700 dark:text-gray-300'
          }`}>
          {role === 'user' ? 'You' : 'AI'}
          {editedAt && !isEditing && (
            <span className="ml-1 text-[10px] text-muted-foreground">(edited)</span>
          )}
        </div>
        {onEdit && onDelete && !isEditing && (
          <MessageActionButtons
            onEdit={onEdit}
            onDelete={onDelete}
            onRetry={onRetry}
            compact
          />
        )}
      </div>

      {isEditing && onSaveEdit && onCancelEdit ? (
        <div className="text-xs">
          <MessageEditor
            initialContent={content}
            onSave={onSaveEdit}
            onCancel={onCancelEdit}
            placeholder="Edit message..."
          />
        </div>
      ) : (
        <>
          <div className={`text-gray-900 dark:text-gray-100 prose prose-xs dark:prose-invert max-w-full overflow-hidden ${styles.compactProseContent}`}>
            <StreamingMarkdown content={content} id={`${messageId}-text`} isStreaming={isStreaming} />
          </div>
          {createdAt && (
            <div className="text-[10px] text-gray-500 mt-1">
              {new Date(createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              {editedAt && (
                <span className="ml-1">
                  (edited)
                </span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
});

CompactTextBlock.displayName = 'CompactTextBlock';

interface CompactMessageRendererProps {
  message: ConversationMessage;
  onEdit?: (messageId: string, newContent: string) => Promise<void>;
  onDelete?: (messageId: string) => Promise<void>;
  onRetry?: (messageId: string) => void;
  onTaskUpdate?: (taskId: string, newStatus: 'pending' | 'in_progress' | 'completed' | 'blocked') => void;
  isLastAssistantMessage?: boolean;
  isLastUserMessage?: boolean;
  /** Whether this message is currently being streamed (for progressive markdown rendering) */
  isStreaming?: boolean;
}

/**
 * Compact message renderer for sidebar - optimized for narrow width.
 * Supports both standard messages and todo_list messages with real-time socket updates.
 */
export const CompactMessageRenderer: React.FC<CompactMessageRendererProps> = React.memo(({
  message,
  onEdit,
  onDelete,
  onRetry,
  onTaskUpdate,
  isLastAssistantMessage = false,
  isLastUserMessage = false,
  isStreaming = false
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const canRetry = Boolean(onRetry) && (isLastAssistantMessage || isLastUserMessage);

  // ============================================
  // Todo List State & Socket (only for todo_list messages)
  // ============================================
  const [tasks, setTasks] = useState<Array<{
    id: string;
    title: string;
    status: 'pending' | 'in_progress' | 'completed' | 'blocked';
    priority: 'low' | 'medium' | 'high';
    position: number;
    updatedAt?: Date;
  }>>([]);
  const [taskList, setTaskList] = useState<{
    id: string;
    title: string;
    description?: string;
    status: string;
    createdAt?: Date;
    updatedAt?: Date;
  } | null>(null);
  const [isLoadingTasks, setIsLoadingTasks] = useState(false);

  // Socket connection (singleton pattern) - only used for todo_list messages
  const socket = useSocket();

  const loadTasksForMessage = async (messageId: string) => {
    setIsLoadingTasks(true);
    try {
      const response = await fetchWithAuth(`/api/ai/tasks/by-message/${messageId}`);
      if (response.ok) {
        const data = await response.json();
        setTasks(data.tasks || []);
        setTaskList(data.taskList);
      } else {
        console.error('Failed to load tasks for message:', messageId);
      }
    } catch (error) {
      console.error('Error loading tasks:', error);
    } finally {
      setIsLoadingTasks(false);
    }
  };

  // Load tasks for todo_list messages
  useEffect(() => {
    if (message.messageType === 'todo_list' && message.id) {
      loadTasksForMessage(message.id);
    }
  }, [message.messageType, message.id]);

  // Listen for real-time task updates
  useEffect(() => {
    if (!socket || message.messageType !== 'todo_list') return;

    const handleTaskUpdate = (payload: {
      taskId: string;
      data: { newStatus: 'pending' | 'in_progress' | 'completed' | 'blocked' };
    }) => {
      const taskInOurMessage = tasks.find(task => task.id === payload.taskId);
      if (taskInOurMessage) {
        setTasks(prevTasks =>
          prevTasks.map(task =>
            task.id === payload.taskId
              ? { ...task, status: payload.data.newStatus, updatedAt: new Date() }
              : task
          )
        );
      }
    };

    const handleTaskListUpdate = (payload: { taskListId: string }) => {
      if (taskList && payload.taskListId === taskList.id) {
        loadTasksForMessage(message.id);
      }
    };

    socket.on('task:task_updated', handleTaskUpdate);
    socket.on('task:task_list_created', handleTaskListUpdate);

    return () => {
      socket.off('task:task_updated', handleTaskUpdate);
      socket.off('task:task_list_created', handleTaskListUpdate);
    };
  }, [socket, message.messageType, message.id, tasks, taskList]);

  const handleTaskStatusUpdate = async (taskId: string, newStatus: 'pending' | 'in_progress' | 'completed' | 'blocked') => {
    try {
      await patch(`/api/ai/tasks/${taskId}/status`, { status: newStatus });
      setTasks(prevTasks =>
        prevTasks.map(task =>
          task.id === taskId ? { ...task, status: newStatus, updatedAt: new Date() } : task
        )
      );
      onTaskUpdate?.(taskId, newStatus);
    } catch (error) {
      console.error('Error updating task:', error);
    }
  };

  // ============================================
  // Standard Message Rendering
  // ============================================
  const groupedParts = useMemo(() => {
    if (!message.parts || message.parts.length === 0) {
      return [];
    }

    const groups: GroupedPart[] = [];
    let currentTextGroup: TextPart[] = [];
    let currentToolGroup: ToolGroupPart[] = [];

    message.parts.forEach((part) => {
      // Skip step-start and reasoning parts - they shouldn't break up tool groups
      if (part.type === 'step-start' || part.type === 'reasoning') {
        return;
      }

      if (part.type === 'text') {
        // If we have accumulated tool parts, add them as a group
        if (currentToolGroup.length > 0) {
          // Always create a group for tool calls, even single ones
          groups.push({
            type: 'tool-calls-group',
            tools: currentToolGroup
          });
          currentToolGroup = [];
        }

        currentTextGroup.push(part as TextPart);
      } else if (part.type.startsWith('tool-')) {
        // If we have accumulated text parts, add them as a group
        if (currentTextGroup.length > 0) {
          groups.push({
            type: 'text-group',
            parts: currentTextGroup
          });
          currentTextGroup = [];
        }

        // Type guard and safe property access for tool parts
        const toolPart = part as ToolPart & Record<string, unknown>;
        const toolCallId = typeof toolPart.toolCallId === 'string' ? toolPart.toolCallId : '';
        const toolName = typeof toolPart.toolName === 'string' ? toolPart.toolName : part.type.replace('tool-', '');

        // Ensure state is one of the valid values with proper type checking
        const validStates = ['input-streaming', 'input-available', 'output-available', 'output-error', 'done', 'streaming'] as const;
        type ValidState = typeof validStates[number];
        const isValidState = (value: unknown): value is ValidState => {
          return typeof value === 'string' && (validStates as readonly string[]).includes(value);
        };
        const state: ValidState = isValidState(toolPart.state) ? toolPart.state : 'input-available';

        // Check if tool type changed - flush current group if different type
        if (currentToolGroup.length > 0 && currentToolGroup[0].type !== part.type) {
          groups.push({
            type: 'tool-calls-group',
            tools: currentToolGroup
          });
          currentToolGroup = [];
        }

        // Add the tool part to current group
        currentToolGroup.push({
          type: part.type,
          toolCallId,
          toolName,
          input: toolPart.input,
          output: toolPart.output,
          state,
        });
      }
    });

    // Add any remaining text parts
    if (currentTextGroup.length > 0) {
      groups.push({
        type: 'text-group',
        parts: currentTextGroup
      });
    }

    // Add any remaining tool parts
    if (currentToolGroup.length > 0) {
      // Always create a group for tool calls, even single ones
      groups.push({
        type: 'tool-calls-group',
        tools: currentToolGroup
      });
    }

    return groups;
  }, [message.parts]);

  const createdAt = message.createdAt;
  const editedAt = message.editedAt;

  const handleSaveEdit = async (newContent: string) => {
    if (onEdit) {
      await onEdit(message.id, newContent);
      setIsEditing(false);
    }
  };

  const handleDelete = async () => {
    if (onDelete) {
      setIsDeleting(true);
      try {
        await onDelete(message.id);
        setShowDeleteDialog(false);
      } catch (error) {
        console.error('Failed to delete message:', error);
      } finally {
        setIsDeleting(false);
      }
    }
  };

  const handleRetry = () => {
    if (onRetry && canRetry) {
      onRetry(message.id);
    }
  };

  // ============================================
  // Render todo_list messages
  // ============================================
  if (message.messageType === 'todo_list') {
    if (isLoadingTasks) {
      return (
        <div className="mb-3">
          <div className="bg-primary/10 dark:bg-primary/20 border border-primary/20 dark:border-primary/30 rounded-md p-2">
            <div className="animate-pulse">
              <div className="h-3 bg-primary/30 dark:bg-primary/50 rounded w-2/3 mb-1"></div>
              <div className="h-1.5 bg-primary/20 dark:bg-primary/40 rounded w-full mb-2"></div>
              <div className="space-y-1">
                <div className="h-6 bg-white dark:bg-gray-800 rounded"></div>
                <div className="h-6 bg-white dark:bg-gray-800 rounded"></div>
              </div>
            </div>
          </div>
        </div>
      );
    }

    if (!taskList || tasks.length === 0) {
      return (
        <div className="mb-3">
          <div className="bg-yellow-50 dark:bg-yellow-950/30 border border-yellow-200 dark:border-yellow-800 rounded-md p-2">
            <div className="text-xs text-yellow-700 dark:text-yellow-300">
              No tasks found for this todo list.
            </div>
          </div>
        </div>
      );
    }

    return (
      <ErrorBoundary
        fallback={
          <div className="mb-3">
            <div className="bg-yellow-50 dark:bg-yellow-950/30 border border-yellow-200 dark:border-yellow-800 rounded-md p-2">
              <div className="text-xs text-yellow-700 dark:text-yellow-300">
                Failed to load TODO list. Please refresh the page.
              </div>
            </div>
          </div>
        }
      >
        <CompactTodoListMessage
          tasks={tasks}
          taskList={taskList}
          createdAt={message.createdAt}
          onTaskUpdate={handleTaskStatusUpdate}
        />
      </ErrorBoundary>
    );
  }

  // ============================================
  // Render standard messages
  // ============================================
  return (
    <>
      <div key={message.id} className="mb-2" style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 80px' }}>
        {groupedParts.map((group, index) => {
          if (group.type === 'text-group') {
            // Type narrowing: we know this is a TextGroupPart
            const textGroup = group as TextGroupPart;
            const isLastTextBlock = index === groupedParts.length - 1;

            return (
              <CompactTextBlock
                key={`${message.id}-text-${index}`}
                parts={textGroup.parts}
                role={message.role as 'user' | 'assistant' | 'system'}
                messageId={message.id}
                createdAt={isLastTextBlock ? createdAt : undefined} // Only show timestamp on last part
                editedAt={isLastTextBlock ? editedAt : undefined}
                onEdit={onEdit ? () => setIsEditing(true) : undefined}
                onDelete={onDelete ? () => setShowDeleteDialog(true) : undefined}
                onRetry={canRetry ? handleRetry : undefined}
                isEditing={isEditing}
                onSaveEdit={handleSaveEdit}
                onCancelEdit={() => setIsEditing(false)}
                isStreaming={isStreaming}
              />
            );
          } else if (group.type === 'tool-calls-group') {
            // Type narrowing: we know this is a ToolCallsGroupPart
            const toolCallsGroup = group as ToolCallsGroupPart;
            return (
              <div key={`${message.id}-toolgroup-${index}`} className="mt-1">
                <CompactGroupedToolCallsRenderer
                  toolCalls={toolCallsGroup.tools.map(tool => ({
                    type: tool.type,
                    toolName: tool.toolName,
                    toolCallId: tool.toolCallId,
                    input: tool.input,
                    output: tool.output,
                    state: tool.state,
                  }))}
                />
              </div>
            );
          } else if (group.type.startsWith('tool-')) {
            // Type narrowing: we know this is a ToolGroupPart
            const toolGroup = group as ToolGroupPart;
            return (
              <div key={`${message.id}-tool-${index}`} className="mt-1">
                <CompactToolCallRenderer
                  part={{
                    type: toolGroup.type,
                    toolName: toolGroup.toolName,
                    toolCallId: toolGroup.toolCallId,
                    input: toolGroup.input,
                    output: toolGroup.output,
                    state: toolGroup.state,
                  }}
                />
              </div>
            );
          }
          return null;
        })}
      </div>

      {onDelete && (
        <DeleteMessageDialog
          open={showDeleteDialog}
          onOpenChange={setShowDeleteDialog}
          onConfirm={handleDelete}
          isDeleting={isDeleting}
        />
      )}
    </>
  );
});

CompactMessageRenderer.displayName = 'CompactMessageRenderer';
