'use client';

import React from 'react';
import { ChevronDown, Loader2 } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { usePageAgents, type AgentSummary } from '@/hooks/page-agents';
import { type AgentInfo } from '@/stores/page-agents';
import { cn } from '@/lib/utils';

/** A minimal, already-scoped agent — for a caller that has its own list rather than a drive to fetch. */
export interface AISelectorAgentOption {
  id: string;
  title: string;
}

interface AISelectorProps {
  selectedAgent: AgentInfo | null;
  onSelectAgent: (agent: AgentInfo | null) => void;
  driveId?: string;
  disabled?: boolean;
  className?: string;
  /**
   * A pre-resolved, already-scoped agent list — when provided, replaces the
   * internal cross-drive fetch entirely. `driveId` alone cannot express "no
   * drive" (an absent `driveId` means "every drive" to `usePageAgents`), so a
   * caller scoped to a single session — which may own no drive at all, in
   * the global-assistant case — supplies its own list instead.
   */
  agents?: readonly AISelectorAgentOption[];
  /** Loading state for `agents`, when provided. */
  agentsLoading?: boolean;
  /** Whether the Global Assistant is offerable. Defaults to true (existing behavior). */
  canPickAssistant?: boolean;
}

/**
 * Agent selector dropdown for switching between Global Assistant and custom AI agents.
 *
 * - Shows "Global Assistant" as the first option
 * - Groups agents by drive when showing multiple drives
 * - Filters to single drive when driveId is provided
 */
export function AISelector({
  selectedAgent,
  onSelectAgent,
  driveId,
  disabled = false,
  className,
  agents: agentsOverride,
  agentsLoading = false,
  canPickAssistant = true,
}: AISelectorProps) {
  const usingOverride = agentsOverride !== undefined;
  const { agentsByDrive, isLoading: fetchedIsLoading, toAgentInfo } = usePageAgents(driveId, {
    enabled: !usingOverride,
  });

  const isLoading = usingOverride ? agentsLoading : fetchedIsLoading;
  const hasAgents = usingOverride
    ? agentsOverride.length > 0
    : agentsByDrive.some(drive => drive.agents.length > 0);
  const showDriveLabels = !usingOverride && !driveId && agentsByDrive.length > 1;

  const handleSelectGlobal = () => {
    onSelectAgent(null);
  };

  const handleSelectAgent = (agent: AgentSummary) => {
    onSelectAgent(toAgentInfo(agent));
  };

  const handleSelectOverrideAgent = (agent: AISelectorAgentOption) => {
    onSelectAgent({ id: agent.id, title: agent.title, driveId: driveId ?? '', driveName: '' });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          variant="ghost"
          className={cn(
            'flex items-center gap-2 px-2 py-1 h-auto font-semibold text-lg hover:bg-accent/50',
            className
          )}
        >
          <span className={selectedAgent ? "truncate min-w-0" : ""}>
            {selectedAgent ? selectedAgent.title : 'Global Assistant'}
          </span>
          <ChevronDown className="h-4 w-4 opacity-50" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-[280px]">
        {/* Global Assistant - always first, when offerable */}
        {canPickAssistant && (
          <DropdownMenuItem
            onClick={handleSelectGlobal}
            className={cn(
              'flex items-center gap-2 cursor-pointer',
              !selectedAgent && 'bg-accent/50'
            )}
            aria-current={!selectedAgent ? 'true' : undefined}
          >
            <span className="font-medium">Global Assistant</span>
            {!selectedAgent && (
              <span className="ml-auto text-xs text-muted-foreground">Active</span>
            )}
          </DropdownMenuItem>
        )}

        {/* Agents section */}
        {isLoading ? (
          <>
            <DropdownMenuSeparator />
            <div className="flex items-center justify-center py-4 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              <span className="text-sm">Loading agents...</span>
            </div>
          </>
        ) : hasAgents ? (
          <>
            <DropdownMenuSeparator />

            {usingOverride ? (
              <DropdownMenuGroup>
                {agentsOverride.map((agent) => {
                  const isSelected = selectedAgent?.id === agent.id;

                  return (
                    <DropdownMenuItem
                      key={agent.id}
                      onClick={() => handleSelectOverrideAgent(agent)}
                      className={cn(
                        'flex items-center gap-2 cursor-pointer',
                        isSelected && 'bg-accent/50'
                      )}
                      aria-current={isSelected ? 'true' : undefined}
                    >
                      <span className="truncate">{agent.title || 'Unnamed Agent'}</span>
                      {isSelected && (
                        <span className="ml-auto text-xs text-muted-foreground">Active</span>
                      )}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuGroup>
            ) : (
              agentsByDrive.map((drive) => {
                if (drive.agents.length === 0) return null;

                return (
                  <DropdownMenuGroup key={drive.driveId}>
                    {showDriveLabels && (
                      <DropdownMenuLabel className="text-xs text-muted-foreground">
                        {drive.driveName}
                      </DropdownMenuLabel>
                    )}

                    {drive.agents.map((agent) => {
                      const isSelected = selectedAgent?.id === agent.id;

                      return (
                        <DropdownMenuItem
                          key={agent.id}
                          onClick={() => handleSelectAgent(agent)}
                          className={cn(
                            'flex items-center gap-2 cursor-pointer',
                            isSelected && 'bg-accent/50'
                          )}
                          aria-current={isSelected ? 'true' : undefined}
                        >
                          <span className="truncate">{agent.title || 'Unnamed Agent'}</span>
                          {isSelected && (
                            <span className="ml-auto text-xs text-muted-foreground">Active</span>
                          )}
                        </DropdownMenuItem>
                      );
                    })}
                  </DropdownMenuGroup>
                );
              })
            )}
          </>
        ) : driveId ? (
          <>
            <DropdownMenuSeparator />
            <div className="px-2 py-4 text-center text-muted-foreground text-sm">
              <p>No agents in this drive</p>
              <p className="text-xs mt-1">Create an AI agent to see it here</p>
            </div>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
