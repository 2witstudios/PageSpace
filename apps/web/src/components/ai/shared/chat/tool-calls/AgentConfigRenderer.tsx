'use client';

import React, { memo } from 'react';
import { Bot, Cpu, Wrench, FileText, CheckCircle, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePageNavigation } from '@/hooks/usePageNavigation';

export interface AgentConfigData {
  hasSystemPrompt?: boolean;
  enabledToolsCount?: number;
  enabledTools?: string[];
  aiProvider?: string | null;
  aiModel?: string | null;
}

interface AgentConfigRendererProps {
  title?: string;
  updatedFields?: string[];
  config?: AgentConfigData;
  message?: string;
  /** Agent page id — enables click-through to open the agent. */
  pageId?: string;
  driveId?: string;
  className?: string;
}

const humanizeField = (field: string): string =>
  field
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();

/**
 * AgentConfigRenderer - Result of update_agent_config.
 *
 * Surfaces which fields changed plus the resulting model/provider, enabled tool
 * count, and whether a system prompt is set.
 */
export const AgentConfigRenderer: React.FC<AgentConfigRendererProps> = memo(function AgentConfigRenderer({
  title = 'Agent',
  updatedFields = [],
  config,
  message,
  pageId,
  driveId,
  className,
}) {
  const { navigateToPage } = usePageNavigation();
  const tools = config?.enabledTools ?? [];
  const toolCount = config?.enabledToolsCount ?? tools.length;

  return (
    <div className={cn('rounded-lg border bg-card overflow-hidden my-2 shadow-sm', className)}>
      <button
        type="button"
        onClick={() => pageId && navigateToPage(pageId, driveId)}
        disabled={!pageId}
        className={cn(
          'w-full flex items-center gap-2 px-3 py-2 bg-muted/30 border-b text-left',
          pageId ? 'hover:bg-muted/50 transition-colors cursor-pointer group' : 'cursor-default'
        )}
      >
        <Bot className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="text-sm font-medium truncate" title={title}>
          {title}
        </span>
        <span className="ml-auto flex items-center gap-2 shrink-0">
          <span className="flex items-center gap-1 text-xs text-green-700 dark:text-green-400">
            <CheckCircle className="h-3 w-3" />
            Configured
          </span>
          {pageId && (
            <ExternalLink className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
          )}
        </span>
      </button>

      <div className="p-3 space-y-2.5">
        {updatedFields.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {updatedFields.map((f) => (
              <span key={f} className="text-xs bg-blue-500/10 text-blue-700 dark:text-blue-400 px-1.5 py-0.5 rounded">
                {humanizeField(f)}
              </span>
            ))}
          </div>
        )}

        <div className="flex items-center gap-3 flex-wrap text-xs text-muted-foreground">
          {(config?.aiProvider || config?.aiModel) && (
            <span className="flex items-center gap-1">
              <Cpu className="h-3.5 w-3.5" />
              {[config?.aiProvider, config?.aiModel].filter(Boolean).join(' · ')}
            </span>
          )}
          <span className="flex items-center gap-1">
            <Wrench className="h-3.5 w-3.5" />
            {toolCount} {toolCount === 1 ? 'tool' : 'tools'}
          </span>
          {config?.hasSystemPrompt && (
            <span className="flex items-center gap-1">
              <FileText className="h-3.5 w-3.5" />
              System prompt set
            </span>
          )}
        </div>

        {tools.length > 0 && (
          <div className="flex flex-wrap gap-1 border-t pt-2">
            {tools.slice(0, 12).map((t) => (
              <code key={t} className="text-[11px] font-mono bg-muted px-1.5 py-0.5 rounded">
                {t}
              </code>
            ))}
            {tools.length > 12 && (
              <span className="text-[11px] text-muted-foreground">+{tools.length - 12} more</span>
            )}
          </div>
        )}

        {message && <p className="text-xs text-muted-foreground">{message}</p>}
      </div>
    </div>
  );
});
