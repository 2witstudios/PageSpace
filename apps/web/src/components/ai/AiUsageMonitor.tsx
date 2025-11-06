'use client';

import { useAiUsage } from '@/hooks/useAiUsage';
import { Progress } from '@/components/ui/progress';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Activity, DollarSign, Database } from 'lucide-react';
import { cn } from '@/lib/utils';

interface AiUsageMonitorProps {
  conversationId: string | null | undefined;
  className?: string;
  compact?: boolean;
}

/**
 * AI Usage Monitor Component
 *
 * Displays real-time token usage, context window visualization, and cost estimation
 * for active AI conversations in PageSpace.
 */
export function AiUsageMonitor({ conversationId, className, compact = false }: AiUsageMonitorProps) {
  const { usage, isLoading } = useAiUsage(conversationId, 5000);

  // Don't render if no conversation or loading
  if (!conversationId || isLoading || !usage) {
    return null;
  }

  // Determine color based on context usage
  const getContextColor = (percent: number) => {
    if (percent < 50) return 'text-green-600 dark:text-green-400';
    if (percent < 75) return 'text-yellow-600 dark:text-yellow-400';
    if (percent < 90) return 'text-orange-600 dark:text-orange-400';
    return 'text-red-600 dark:text-red-400';
  };

  const getProgressColor = (percent: number) => {
    if (percent < 50) return 'bg-green-500';
    if (percent < 75) return 'bg-yellow-500';
    if (percent < 90) return 'bg-orange-500';
    return 'bg-red-500';
  };

  const formatNumber = (num: number) => {
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num.toString();
  };

  const formatCost = (cost: number) => {
    if (cost === 0) return 'Free';
    if (cost < 0.01) return `$${cost.toFixed(4)}`;
    return `$${cost.toFixed(2)}`;
  };

  if (compact) {
    return (
      <TooltipProvider>
        <div className={cn('flex items-center gap-2 text-xs', className)}>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1">
                <Database className="h-3 w-3 text-muted-foreground" />
                <span className={cn('font-mono', getContextColor(usage.contextUsagePercent))}>
                  {usage.contextUsagePercent}%
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent>
              <p>Context: {formatNumber(usage.totalTokens)} / {formatNumber(usage.contextWindowSize)} tokens</p>
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1">
                <Activity className="h-3 w-3 text-muted-foreground" />
                <span className="font-mono text-muted-foreground">{formatNumber(usage.totalTokens)}</span>
              </div>
            </TooltipTrigger>
            <TooltipContent>
              <p>Input: {formatNumber(usage.inputTokens)} tokens</p>
              <p>Output: {formatNumber(usage.outputTokens)} tokens</p>
            </TooltipContent>
          </Tooltip>

          {usage.cost > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex items-center gap-1">
                  <DollarSign className="h-3 w-3 text-muted-foreground" />
                  <span className="font-mono text-muted-foreground">{formatCost(usage.cost)}</span>
                </div>
              </TooltipTrigger>
              <TooltipContent>
                <p>Total cost for this conversation</p>
                <p className="text-xs text-muted-foreground">Model: {usage.model}</p>
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <div className={cn('flex flex-col gap-2 p-3 rounded-lg border bg-card text-card-foreground', className)}>
        {/* Header */}
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span className="font-medium">AI Usage</span>
          <span className="font-mono">{usage.model}</span>
        </div>

        {/* Context Window Progress */}
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Context Window</span>
            <span className={cn('font-mono font-medium', getContextColor(usage.contextUsagePercent))}>
              {usage.contextUsagePercent}%
            </span>
          </div>
          <div className="relative">
            <Progress
              value={usage.contextUsagePercent}
              className="h-2"
              indicatorClassName={getProgressColor(usage.contextUsagePercent)}
            />
          </div>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="font-mono">{formatNumber(usage.totalTokens)}</span>
            <span className="font-mono">{formatNumber(usage.contextWindowSize)}</span>
          </div>
        </div>

        {/* Token Breakdown */}
        <div className="grid grid-cols-2 gap-2 pt-1 border-t">
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1.5 text-xs">
                <Activity className="h-3.5 w-3.5 text-blue-500" />
                <div className="flex flex-col">
                  <span className="text-muted-foreground">Input</span>
                  <span className="font-mono font-medium">{formatNumber(usage.inputTokens)}</span>
                </div>
              </div>
            </TooltipTrigger>
            <TooltipContent>
              <p>Tokens used for input (prompts + context)</p>
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1.5 text-xs">
                <Activity className="h-3.5 w-3.5 text-purple-500" />
                <div className="flex flex-col">
                  <span className="text-muted-foreground">Output</span>
                  <span className="font-mono font-medium">{formatNumber(usage.outputTokens)}</span>
                </div>
              </div>
            </TooltipTrigger>
            <TooltipContent>
              <p>Tokens used for AI responses</p>
            </TooltipContent>
          </Tooltip>
        </div>

        {/* Cost (if applicable) */}
        {usage.cost > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center justify-between pt-1 border-t text-xs">
                <span className="text-muted-foreground">Cost</span>
                <span className="font-mono font-medium">{formatCost(usage.cost)}</span>
              </div>
            </TooltipTrigger>
            <TooltipContent>
              <p>Total cost for this conversation</p>
              <p className="text-xs text-muted-foreground">Provider: {usage.provider}</p>
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </TooltipProvider>
  );
}
