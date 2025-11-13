'use client';

import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, CheckCircle2, XCircle, Clock } from 'lucide-react';
import { CompactToolCallRenderer } from './CompactToolCallRenderer';
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

interface CompactGroupedToolCallsRendererProps {
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

function getStatusIcon(status: ToolStatus, size = 'h-3 w-3') {
  switch (status) {
    case 'in_progress':
      return <Loader2 className={cn(size, 'animate-spin text-blue-500')} />;
    case 'completed':
      return <CheckCircle2 className={cn(size, 'text-green-500')} />;
    case 'error':
      return <XCircle className={cn(size, 'text-red-500')} />;
    case 'pending':
      return <Clock className={cn(size, 'text-gray-400')} />;
  }
}

export function CompactGroupedToolCallsRenderer({ toolCalls, className }: CompactGroupedToolCallsRendererProps) {
  const [isExpanded, setIsExpanded] = useState(false);

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

  // Auto-expand if any tool is in progress or has errors
  const shouldAutoExpand = useMemo(() => {
    return toolCallsWithStatus.some(tool =>
      tool.status === 'in_progress' || tool.status === 'error'
    );
  }, [toolCallsWithStatus]);

  // Update expanded state if should auto-expand
  React.useEffect(() => {
    if (shouldAutoExpand && !isExpanded) {
      setIsExpanded(true);
    }
  }, [shouldAutoExpand, isExpanded]);

  // Find the current active tool (first in_progress or error)
  const activeToolIndex = useMemo(() => {
    return toolCallsWithStatus.findIndex(tool =>
      tool.status === 'in_progress' || tool.status === 'error'
    );
  }, [toolCallsWithStatus]);

  // Format compact summary text
  const summaryText = useMemo(() => {
    const parts: string[] = [];

    if (summary.in_progress > 0) {
      parts.push(`${summary.in_progress} active`);
    } else if (summary.completed === summary.total) {
      parts.push('all done');
    } else if (summary.error > 0) {
      parts.push(`${summary.error} failed`);
    } else {
      parts.push(`${summary.completed}/${summary.total}`);
    }

    return parts[0]; // Only show the most relevant status
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
        <CompactToolCallRenderer part={toolCalls[0]} />
      </div>
    );
  }

  return (
    <div className={cn('my-1.5', className)}>
      <div className="bg-gray-50 dark:bg-gray-800/30 rounded border border-gray-200 dark:border-gray-700">
        {/* Group Header */}
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="w-full flex items-center space-x-1.5 p-2 text-left hover:bg-gray-100 dark:hover:bg-gray-800/50 transition-colors rounded"
        >
          <div className="flex-shrink-0">
            {isExpanded ? (
              <ChevronDown className="h-3 w-3 text-gray-500" />
            ) : (
              <ChevronRight className="h-3 w-3 text-gray-500" />
            )}
          </div>
          <div className="flex-shrink-0">
            {getStatusIcon(groupStatus, 'h-3.5 w-3.5')}
          </div>
          <div className="flex-1 min-w-0">
            <span className="font-medium text-[11px] text-gray-900 dark:text-gray-100">
              {summary.total} tool{summary.total !== 1 ? 's' : ''}
            </span>
          </div>
          <div className="flex-shrink-0">
            <span className="text-[10px] text-gray-500 dark:text-gray-400">
              {summaryText}
            </span>
          </div>
        </button>

        {/* Expanded Tool Calls */}
        {isExpanded && (
          <div className="border-t border-gray-200 dark:border-gray-700">
            <div className="p-1.5 space-y-1.5">
              {toolCallsWithStatus.map((tool, index) => {
                const isActive = index === activeToolIndex;
                return (
                  <div
                    key={tool.toolCallId || `tool-${index}`}
                    className={cn(
                      'relative',
                      isActive && 'ring-1 ring-blue-500 ring-opacity-50 rounded'
                    )}
                  >
                    {isActive && (
                      <div className="absolute -left-0.5 top-0 bottom-0 w-0.5 bg-blue-500 rounded-l" />
                    )}
                    <CompactToolCallRenderer part={tool} />
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
