'use client';

import React, { memo } from 'react';
import { usePageNavigation } from '@/hooks/usePageNavigation';
import { Sparkles, ExternalLink, MessageSquare } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface AgentInfo {
  pageId: string;
  title: string;
  driveId?: string;
  driveName?: string;
  description?: string;
  model?: string;
}

interface AgentListRendererProps {
  /** List of agents */
  agents: AgentInfo[];
  /** Whether this is a multi-drive result */
  isMultiDrive?: boolean;
  /** Title override */
  title?: string;
  /** Maximum height before scrolling */
  maxHeight?: number;
  /** Additional CSS class */
  className?: string;
}

/**
 * AgentListRenderer - Displays a list of AI agents
 *
 * Features:
 * - Click to navigate to agent page
 * - Shows model info if available
 * - Groups by drive for multi-drive results
 * - Clean, minimal design
 */
export const AgentListRenderer: React.FC<AgentListRendererProps> = memo(function AgentListRenderer({
  agents,
  isMultiDrive = false,
  title,
  maxHeight = 300,
  className
}) {
  const { navigateToPage } = usePageNavigation();

  const handleNavigate = (pageId: string, driveId?: string) => {
    navigateToPage(pageId, driveId);
  };

  const displayTitle = title || (isMultiDrive ? 'AI Agents (All Workspaces)' : 'AI Agents');

  return (
    <div className={cn("rounded-lg border bg-card overflow-hidden my-2 shadow-sm", className)}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-muted/30 border-b">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">{displayTitle}</span>
        </div>
        <span className="text-xs text-muted-foreground">
          {agents.length} {agents.length === 1 ? 'agent' : 'agents'}
        </span>
      </div>

      {/* Agent list */}
      <div
        className="bg-background overflow-auto divide-y divide-border"
        style={{ maxHeight: `${maxHeight}px` }}
      >
        {agents.length > 0 ? (
          agents.map((agent, index) => (
            <button
              key={`${agent.pageId}-${index}`}
              type="button"
              onClick={() => handleNavigate(agent.pageId, agent.driveId)}
              className="w-full text-left px-3 py-2.5 hover:bg-muted/50 transition-colors group"
            >
              <div className="flex items-center gap-3">
                {/* Agent icon */}
                <div className="flex items-center justify-center w-8 h-8 rounded-md bg-primary/10 shrink-0">
                  <Sparkles className="h-4 w-4 text-primary" />
                </div>

                {/* Agent info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">
                      {agent.title}
                    </span>
                    {agent.model && (
                      <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded truncate max-w-[100px]">
                        {agent.model}
                      </span>
                    )}
                  </div>
                  {agent.driveName && isMultiDrive && (
                    <div className="text-xs text-muted-foreground mt-0.5">
                      in {agent.driveName}
                    </div>
                  )}
                  {agent.description && (
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">
                      {agent.description}
                    </p>
                  )}
                </div>

                {/* Navigate indicator */}
                <div className="flex items-center gap-2 shrink-0">
                  <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
                  <ExternalLink className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
              </div>
            </button>
          ))
        ) : (
          <div className="text-sm text-muted-foreground text-center py-6">
            <Sparkles className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p>No agents found</p>
          </div>
        )}
      </div>
    </div>
  );
});
