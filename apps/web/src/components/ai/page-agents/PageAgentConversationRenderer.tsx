import React from 'react';
import { Loader2, AlertCircle } from 'lucide-react';
import { Task, TaskTrigger, TaskContent, TaskItem, TaskStatus } from '@/components/ai/task';
import { Badge } from '@/components/ui/badge';
import { MemoizedMarkdown } from '@/components/ai/shared/MemoizedMarkdown';

interface AgentConversationOutput {
  success: boolean;
  agent?: string;
  agentPath?: string;
  question?: string;
  response?: string;
  context?: string;
  error?: string;
  metadata?: {
    agentId?: string;
    processingTime?: number;
    messagesInHistory?: number;
    callDepth?: number;
    provider?: string;
    model?: string;
    toolsEnabled?: number;
  };
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

interface PageAgentConversationRendererProps {
  part: ToolPart;
}

type AskAgentInput = {
  agentPath?: string;
  agentId?: string;
  question?: string;
  context?: string;
};

export const PageAgentConversationRenderer: React.FC<PageAgentConversationRendererProps> = ({ part }) => {
  const state = part.state || 'input-streaming';

  // Try to parse output into a typed shape
  let output: AgentConversationOutput | null = null;
  if (part.output) {
    try {
      output = typeof part.output === 'string' ? JSON.parse(part.output) : (part.output as AgentConversationOutput);
    } catch {
      output = null;
    }
  }

  // Parse input for fallbacks (inquiry + target agent)
  let inputData: AskAgentInput | null = null;
  if (part.input) {
    try {
      inputData = typeof part.input === 'string' 
        ? (JSON.parse(part.input) as AskAgentInput) 
        : (part.input as AskAgentInput);
    } catch {
      inputData = null;
    }
  }

  const agentLabel = output?.agent || output?.agentPath || inputData?.agentPath || 'Agent';
  const question = output?.question ?? inputData?.question;
  const response = output?.response;
  const context = output?.context;
  const error = part.errorText || output?.error;

  // Convert AI SDK state to Task status
  const getTaskStatus = (): TaskStatus => {
    if (state === 'output-error' || (output && !output.success)) return 'error';
    if (state === 'output-available' || state === 'done') return 'completed';
    if (state === 'input-streaming' || state === 'input-available' || state === 'streaming') return 'in_progress';
    return 'pending';
  };

  const taskStatus = getTaskStatus();

  // Get task title based on state
  const getTaskTitle = (): string => {
    if (taskStatus === 'error') {
      return `Ask Agent: Failed - ${agentLabel}`;
    }
    if (taskStatus === 'in_progress') {
      return `Ask Agent: Consulting ${agentLabel}...`;
    }
    if (taskStatus === 'completed' && output?.agent) {
      return `Ask Agent: ${output.agent}`;
    }
    return 'Ask Agent';
  };

  // Use Task accordion pattern (like other tools)
  return (
    <Task defaultOpen={taskStatus === 'in_progress' || taskStatus === 'error'} className="my-2">
      <TaskTrigger
        title={getTaskTitle()}
        status={taskStatus}
      />
      <TaskContent>
        {/* Loading state */}
        {taskStatus === 'in_progress' && (
          <TaskItem status="in_progress">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            Processing inquiry with {agentLabel}...
          </TaskItem>
        )}
        
        {/* Error state */}
        {taskStatus === 'error' && (
          <>
            <TaskItem status="error">
              <AlertCircle className="h-4 w-4 mr-2" />
              Agent consultation failed
            </TaskItem>
            {error && (
              <div className="mt-2 p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-xs">
                <div className="text-red-600 dark:text-red-400">{error}</div>
              </div>
            )}
          </>
        )}
        
        {/* Success state - Beautiful conversation display */}
        {taskStatus === 'completed' && output && (
          <div className="space-y-3">
            {/* Provider/Model badges (only non-default) */}
            {(output.metadata?.provider && output.metadata.provider !== 'default') || 
             (output.metadata?.model && output.metadata.model !== 'default') ? (
              <div className="flex items-center gap-2 flex-wrap">
                {output.metadata?.provider && output.metadata.provider !== 'default' && (
                  <Badge variant="secondary" className="capitalize text-xs">
                    {output.metadata.provider}
                  </Badge>
                )}
                {output.metadata?.model && output.metadata.model !== 'default' && (
                  <Badge variant="outline" className="text-xs">
                    {output.metadata.model}
                  </Badge>
                )}
              </div>
            ) : null}
            
            {/* Context if provided */}
            {context && (
              <div className="text-xs text-muted-foreground px-2">
                <span className="font-medium">Context:</span> {context}
              </div>
            )}
            
            {/* Question */}
            {question && (
              <div className="bg-gray-50 dark:bg-gray-800/50 rounded-md p-3">
                <div className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Question
                </div>
                <div className="text-sm text-gray-900 dark:text-gray-100 whitespace-pre-wrap">
                  {question}
                </div>
              </div>
            )}
            
            {/* Response with markdown */}
            {response && (
              <div className="bg-white dark:bg-gray-900 rounded-md p-3 border border-gray-200 dark:border-gray-800">
                <div className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Response
                </div>
                <div className="text-gray-900 dark:text-gray-100 prose prose-sm dark:prose-invert max-w-none prose-pre:bg-gray-100 dark:prose-pre:bg-gray-800">
                  <MemoizedMarkdown 
                    content={response} 
                    id={`ask-agent-${part.toolCallId || 'response'}`} 
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </TaskContent>
    </Task>
  );
};