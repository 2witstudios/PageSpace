'use client';

import React from 'react';
import { ChevronDown, Sparkles, Bot, Loader2 } from 'lucide-react';
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
import { useAgents, AgentSummary } from '@/hooks/useAgents';
import { AgentInfo } from '@/contexts/GlobalChatContext';
import { cn } from '@/lib/utils';

interface AgentSelectorProps {
  selectedAgent: AgentInfo | null;
  onSelectAgent: (agent: AgentInfo | null) => void;
  driveId?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Agent selector dropdown for switching between Global Assistant and custom AI agents.
 *
 * - Shows "Global Assistant" as the first option
 * - Groups agents by drive when showing multiple drives
 * - Filters to single drive when driveId is provided
 */
export function AgentSelector({
  selectedAgent,
  onSelectAgent,
  driveId,
  disabled = false,
  className,
}: AgentSelectorProps) {
  const { agentsByDrive, isLoading, toAgentInfo } = useAgents(driveId);

  const hasAgents = agentsByDrive.some(drive => drive.agents.length > 0);
  const showDriveLabels = !driveId && agentsByDrive.length > 1;

  const handleSelectGlobal = () => {
    onSelectAgent(null);
  };

  const handleSelectAgent = (agent: AgentSummary) => {
    onSelectAgent(toAgentInfo(agent));
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
          {selectedAgent ? (
            <>
              <Bot className="h-5 w-5 text-primary" />
              <span className="truncate max-w-[200px]">{selectedAgent.title}</span>
            </>
          ) : (
            <>
              <Sparkles className="h-5 w-5 text-primary" />
              <span>Global Assistant</span>
            </>
          )}
          <ChevronDown className="h-4 w-4 opacity-50" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-[280px]">
        {/* Global Assistant - always first */}
        <DropdownMenuItem
          onClick={handleSelectGlobal}
          className={cn(
            'flex items-center gap-2 cursor-pointer',
            !selectedAgent && 'bg-accent/50'
          )}
          aria-current={!selectedAgent ? 'true' : undefined}
        >
          <Sparkles className="h-4 w-4 text-primary" />
          <span className="font-medium">Global Assistant</span>
          {!selectedAgent && (
            <span className="ml-auto text-xs text-muted-foreground">Active</span>
          )}
        </DropdownMenuItem>

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

            {agentsByDrive.map((drive) => {
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
                        <Bot className="h-4 w-4 text-muted-foreground" />
                        <span className="truncate">{agent.title || 'Unnamed Agent'}</span>
                        {isSelected && (
                          <span className="ml-auto text-xs text-muted-foreground">Active</span>
                        )}
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuGroup>
              );
            })}
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

export default AgentSelector;
