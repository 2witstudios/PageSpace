/**
 * Agent Mode Selector Component
 *
 * Allows users to switch between:
 * 1. Fixed modes (PARTNER, PLANNER, WRITER)
 * 2. Custom AI agents created by the user
 */

import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '@/components/ui/tooltip';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Bot, Sparkles, Users, RefreshCw } from 'lucide-react';
import { AgentRole, ROLE_METADATA } from '@/lib/ai/agent-roles';
import { useGlobalChat } from '@/contexts/GlobalChatContext';

interface AgentModeSelectorProps {
  currentMode: 'role' | 'agent'; // role = fixed modes, agent = custom agent
  currentRole?: AgentRole;
  onRoleChange?: (role: AgentRole) => void;
  disabled?: boolean;
  variant?: 'compact' | 'detailed';
}

export function AgentModeSelector({
  currentMode,
  currentRole = AgentRole.PARTNER,
  onRoleChange,
  disabled = false,
  variant = 'compact',
}: AgentModeSelectorProps) {
  const {
    selectedAgent,
    isAgentMode,
    availableAgents,
    setSelectedAgent,
    loadAvailableAgents,
  } = useGlobalChat();

  const [showDialog, setShowDialog] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  // Load available agents on mount
  useEffect(() => {
    loadAvailableAgents();
  }, [loadAvailableAgents]);

  const handleModeChange = async (value: string) => {
    setIsLoading(true);
    try {
      if (value === 'role-partner' || value === 'role-planner' || value === 'role-writer') {
        // Switch to fixed role mode
        await setSelectedAgent(null);
        const role = value.replace('role-', '').toUpperCase() as AgentRole;
        onRoleChange?.(role);
      } else if (value.startsWith('agent-')) {
        // Switch to custom agent mode
        const agentId = value.replace('agent-', '');
        await setSelectedAgent(agentId);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const getCurrentValue = () => {
    if (isAgentMode && selectedAgent) {
      return `agent-${selectedAgent.id}`;
    }
    return `role-${currentRole.toLowerCase()}`;
  };

  const getCurrentLabel = () => {
    if (isAgentMode && selectedAgent) {
      return selectedAgent.title || 'Custom Agent';
    }
    return ROLE_METADATA[currentRole].label;
  };

  const getCurrentIcon = () => {
    if (isAgentMode && selectedAgent) {
      return <Bot className="h-4 w-4" />;
    }
    return ROLE_METADATA[currentRole].icon || <Sparkles className="h-4 w-4" />;
  };

  if (variant === 'detailed') {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">AI Assistant Mode</h3>
          <Dialog open={showDialog} onOpenChange={setShowDialog}>
            <DialogTrigger asChild>
              <Button variant="ghost" size="sm">
                <Sparkles className="h-4 w-4" />
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl">
              <DialogHeader>
                <DialogTitle>Choose Assistant Mode</DialogTitle>
                <DialogDescription>
                  Select a fixed mode (Partner, Planner, Writer) or choose one of your custom AI agents.
                </DialogDescription>
              </DialogHeader>
              <AgentModeDetailsView
                currentMode={currentMode}
                currentRole={currentRole}
                selectedAgent={selectedAgent}
                availableAgents={availableAgents}
                onSelect={async (value) => {
                  await handleModeChange(value);
                  setShowDialog(false);
                }}
                onRefresh={loadAvailableAgents}
              />
            </DialogContent>
          </Dialog>
        </div>

        <Select value={getCurrentValue()} onValueChange={handleModeChange} disabled={disabled || isLoading}>
          <SelectTrigger className="w-full">
            <SelectValue>
              <div className="flex items-center space-x-2">
                {getCurrentIcon()}
                <span>{getCurrentLabel()}</span>
                {isAgentMode && <Badge variant="secondary" className="text-xs">Custom</Badge>}
              </div>
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>Fixed Modes</SelectLabel>
              {Object.values(AgentRole).map((role) => {
                const metadata = ROLE_METADATA[role];
                return (
                  <SelectItem key={role} value={`role-${role.toLowerCase()}`}>
                    <div className="flex items-center space-x-2">
                      <span>{metadata.icon}</span>
                      <span>{metadata.label}</span>
                    </div>
                  </SelectItem>
                );
              })}
            </SelectGroup>

            {availableAgents.length > 0 && (
              <>
                <SelectSeparator />
                <SelectGroup>
                  <SelectLabel className="flex items-center justify-between">
                    <span>Custom Agents</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 w-5 p-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        loadAvailableAgents();
                      }}
                    >
                      <RefreshCw className="h-3 w-3" />
                    </Button>
                  </SelectLabel>
                  {availableAgents.map((agent) => (
                    <SelectItem key={agent.id} value={`agent-${agent.id}`}>
                      <div className="flex items-center space-x-2">
                        <Bot className="h-4 w-4" />
                        <span className="truncate">{agent.title || 'Untitled Agent'}</span>
                        <Badge variant="outline" className="text-xs">
                          {agent.enabledToolsCount} tools
                        </Badge>
                      </div>
                    </SelectItem>
                  ))}
                </SelectGroup>
              </>
            )}
          </SelectContent>
        </Select>

        <div className="text-xs text-muted-foreground">
          {isAgentMode && selectedAgent
            ? `Using custom agent: ${selectedAgent.title}`
            : `Using ${ROLE_METADATA[currentRole].label} mode`}
        </div>
      </div>
    );
  }

  // Compact variant
  return (
    <div className="flex items-center space-x-2">
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center space-x-2 px-3 py-1.5 bg-muted rounded-md">
              {getCurrentIcon()}
              <span className="text-sm font-medium">{getCurrentLabel()}</span>
              {isAgentMode && <Badge variant="secondary" className="text-xs">Custom</Badge>}
            </div>
          </TooltipTrigger>
          <TooltipContent>
            <div className="space-y-1">
              <p className="font-medium">Current Mode</p>
              <p className="text-sm">
                {isAgentMode && selectedAgent
                  ? `Custom Agent: ${selectedAgent.title}`
                  : `${ROLE_METADATA[currentRole].label} - ${ROLE_METADATA[currentRole].shortDescription}`}
              </p>
            </div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <Select value={getCurrentValue()} onValueChange={handleModeChange} disabled={disabled || isLoading}>
        <SelectTrigger className="w-[200px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Fixed Modes</SelectLabel>
            {Object.values(AgentRole).map((role) => {
              const metadata = ROLE_METADATA[role];
              return (
                <SelectItem key={role} value={`role-${role.toLowerCase()}`}>
                  <div className="flex items-center space-x-2">
                    <span>{metadata.icon}</span>
                    <span>{metadata.label}</span>
                  </div>
                </SelectItem>
              );
            })}
          </SelectGroup>

          {availableAgents.length > 0 && (
            <>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>Custom Agents ({availableAgents.length})</SelectLabel>
                {availableAgents.slice(0, 5).map((agent) => (
                  <SelectItem key={agent.id} value={`agent-${agent.id}`}>
                    <div className="flex items-center space-x-2">
                      <Bot className="h-4 w-4" />
                      <span className="truncate max-w-[150px]">{agent.title || 'Untitled'}</span>
                    </div>
                  </SelectItem>
                ))}
                {availableAgents.length > 5 && (
                  <SelectItem value="more" disabled>
                    <span className="text-xs text-muted-foreground">
                      +{availableAgents.length - 5} more...
                    </span>
                  </SelectItem>
                )}
              </SelectGroup>
            </>
          )}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * Detailed view for the dialog
 */
function AgentModeDetailsView({
  currentMode,
  currentRole,
  selectedAgent,
  availableAgents,
  onSelect,
  onRefresh,
}: {
  currentMode: 'role' | 'agent';
  currentRole: AgentRole;
  selectedAgent: any;
  availableAgents: any[];
  onSelect: (value: string) => void;
  onRefresh: () => void;
}) {
  return (
    <ScrollArea className="h-[500px] pr-4">
      <div className="space-y-6">
        {/* Fixed Modes Section */}
        <div>
          <h4 className="text-sm font-medium mb-3 flex items-center space-x-2">
            <Sparkles className="h-4 w-4" />
            <span>Fixed Modes</span>
          </h4>
          <div className="grid gap-3">
            {Object.values(AgentRole).map((role) => {
              const metadata = ROLE_METADATA[role];
              const isActive = currentMode === 'role' && currentRole === role;

              return (
                <button
                  key={role}
                  onClick={() => onSelect(`role-${role.toLowerCase()}`)}
                  className={`text-left p-4 rounded-lg border transition-all ${
                    isActive
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:border-primary/50'
                  }`}
                >
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center space-x-2">
                      <span className="text-xl">{metadata.icon}</span>
                      <div>
                        <div className="font-medium">{metadata.label}</div>
                        <div className="text-xs text-muted-foreground">
                          {metadata.shortDescription}
                        </div>
                      </div>
                    </div>
                    {isActive && <Badge variant="default">Active</Badge>}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {metadata.primaryUseCase}
                  </p>
                </button>
              );
            })}
          </div>
        </div>

        {/* Custom Agents Section */}
        <div>
          <h4 className="text-sm font-medium mb-3 flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <Users className="h-4 w-4" />
              <span>Custom Agents</span>
              <Badge variant="outline">{availableAgents.length}</Badge>
            </div>
            <Button variant="ghost" size="sm" onClick={onRefresh}>
              <RefreshCw className="h-4 w-4" />
            </Button>
          </h4>

          {availableAgents.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Bot className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">No custom agents found</p>
              <p className="text-xs mt-1">Create AI_CHAT pages to add custom agents</p>
            </div>
          ) : (
            <div className="grid gap-3">
              {availableAgents.map((agent) => {
                const isActive = currentMode === 'agent' && selectedAgent?.id === agent.id;

                return (
                  <button
                    key={agent.id}
                    onClick={() => onSelect(`agent-${agent.id}`)}
                    className={`text-left p-4 rounded-lg border transition-all ${
                      isActive
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:border-primary/50'
                    }`}
                  >
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex items-center space-x-2">
                        <Bot className="h-5 w-5" />
                        <div>
                          <div className="font-medium">{agent.title || 'Untitled Agent'}</div>
                          <div className="text-xs text-muted-foreground">
                            {agent.driveName} • {agent.enabledToolsCount} tools
                          </div>
                        </div>
                      </div>
                      {isActive && <Badge variant="default">Active</Badge>}
                    </div>
                    {agent.systemPrompt && (
                      <p className="text-sm text-muted-foreground line-clamp-2">
                        {agent.systemPrompt.substring(0, 100)}
                        {agent.systemPrompt.length > 100 ? '...' : ''}
                      </p>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </ScrollArea>
  );
}
