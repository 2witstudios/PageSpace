'use client';

import React, { useMemo, useState, useEffect } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChevronDown, Loader2, CheckCircle2, XCircle, Clock } from 'lucide-react';
import { ToolCallRenderer } from './ToolCallRenderer';
import { cn } from '@/lib/utils';

interface ToolCallPart {
  type: string;
  toolName?: string;
  toolCallId?: string;
  state?: 'input-streaming' | 'input-available' | 'output-available' | 'output-error' | 'done' | 'streaming';
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

interface GroupedToolCallsRendererProps {
  toolCalls: ToolCallPart[];
  className?: string;
}

type ToolStatus = 'pending' | 'in_progress' | 'completed' | 'error';

interface ToolCallWithStatus extends ToolCallPart {
  status: ToolStatus;
  index: number;
}

function getToolStatus(state?: string): ToolStatus {
  if (!state) return 'pending';

  switch (state) {
    case 'input-streaming':
    case 'streaming':
      return 'in_progress';
    case 'output-error':
      return 'error';
    case 'done':
    case 'output-available':
      return 'completed';
    case 'input-available':
      return 'in_progress';
    default:
      return 'pending';
  }
}

function getStatusIcon(status: ToolStatus) {
  switch (status) {
    case 'in_progress':
      return <Loader2 className="h-4 w-4 animate-spin text-blue-500" />;
    case 'completed':
      return <CheckCircle2 className="h-4 w-4 text-green-500" />;
    case 'error':
      return <XCircle className="h-4 w-4 text-red-500" />;
    case 'pending':
      return <Clock className="h-4 w-4 text-gray-400" />;
  }
}

export function GroupedToolCallsRenderer({ toolCalls, className }: GroupedToolCallsRendererProps) {
  // Process tool calls with status
  const toolCallsWithStatus = useMemo<ToolCallWithStatus[]>(() => {
    return toolCalls.map((tool, index) => ({
      ...tool,
      status: getToolStatus(tool.state),
      index,
    }));
  }, [toolCalls]);

  // Calculate summary stats
  const summary = useMemo(() => {
    const stats = {
      total: toolCalls.length,
      completed: 0,
      in_progress: 0,
      error: 0,
      pending: 0,
    };

    toolCallsWithStatus.forEach(tool => {
      stats[tool.status]++;
    });

    return stats;
  }, [toolCallsWithStatus, toolCalls.length]);

  // Determine if group should be expanded
  const shouldExpand = useMemo(() => {
    return toolCallsWithStatus.some(tool =>
      tool.status === 'in_progress' || tool.status === 'error'
    );
  }, [toolCallsWithStatus]);

  // Controlled open state - starts with shouldExpand value
  const [isOpen, setIsOpen] = useState(shouldExpand);

  // Auto-expand when shouldExpand becomes true
  useEffect(() => {
    if (shouldExpand) {
      setIsOpen(true);
    }
  }, [shouldExpand]);

  // Find the current active tool (first in_progress or error)
  const activeToolIndex = useMemo(() => {
    return toolCallsWithStatus.findIndex(tool =>
      tool.status === 'in_progress' || tool.status === 'error'
    );
  }, [toolCallsWithStatus]);

  // Format summary text
  const summaryText = useMemo(() => {
    const parts: string[] = [];

    if (summary.completed > 0) {
      parts.push(`${summary.completed} completed`);
    }
    if (summary.in_progress > 0) {
      parts.push(`${summary.in_progress} in progress`);
    }
    if (summary.error > 0) {
      parts.push(`${summary.error} failed`);
    }
    if (summary.pending > 0) {
      parts.push(`${summary.pending} pending`);
    }

    return parts.join(', ');
  }, [summary]);

  // Overall status for the group
  const groupStatus = useMemo<ToolStatus>(() => {
    if (summary.error > 0) return 'error';
    if (summary.in_progress > 0) return 'in_progress';
    if (summary.pending > 0) return 'pending';
    return 'completed';
  }, [summary]);

  // If only one tool call, render directly without grouping
  if (toolCalls.length === 1) {
    return (
      <div className={className}>
        <ToolCallRenderer part={toolCalls[0]} />
      </div>
    );
  }

  return (
    <div className={cn('my-2', className)}>
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <div className="border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900">
          <CollapsibleTrigger className="w-full flex items-center justify-between p-3 text-left hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors group">
            <div className="flex items-center space-x-3 flex-1 min-w-0">
              <div className="flex-shrink-0">
                {getStatusIcon(groupStatus)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-medium text-sm text-gray-900 dark:text-gray-100">
                  {summary.total} tool call{summary.total !== 1 ? 's' : ''}
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  {summaryText}
                </div>
              </div>
            </div>
            <ChevronDown className="h-4 w-4 text-gray-500 transition-transform duration-200 group-data-[state=open]:rotate-180" />
          </CollapsibleTrigger>

          <CollapsibleContent>
            <div className="border-t border-gray-200 dark:border-gray-700">
              <div className="p-2 space-y-2">
                {toolCallsWithStatus.map((tool, index) => {
                  const isActive = index === activeToolIndex;
                  return (
                    <div
                      key={tool.toolCallId || `tool-${index}`}
                      className={cn(
                        'relative',
                        isActive && 'ring-2 ring-blue-500 ring-opacity-50 rounded-lg'
                      )}
                    >
                      {isActive && (
                        <div className="absolute -left-1 top-0 bottom-0 w-1 bg-blue-500 rounded-l" />
                      )}
                      <ToolCallRenderer part={tool} />
                    </div>
                  );
                })}
              </div>
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>
    </div>
  );
}
