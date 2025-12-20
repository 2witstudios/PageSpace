'use client';

import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Wrench, Globe, Pencil, PencilOff, GitBranch, Server, ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface ToolsPopoverProps {
  /** Whether web search is enabled */
  webSearchEnabled?: boolean;
  /** Callback when web search is toggled */
  onWebSearchToggle?: (enabled: boolean) => void;
  /** Whether write mode is active (true = write, false = read only) */
  writeMode?: boolean;
  /** Callback when write mode is toggled */
  onWriteModeToggle?: (enabled: boolean) => void;
  /** Whether to show workspace page tree context to AI */
  showPageTree?: boolean;
  /** Callback when page tree context is toggled */
  onShowPageTreeToggle?: (enabled: boolean) => void;
  /** Number of running MCP servers */
  mcpRunningServers?: number;
  /** Names of running MCP servers */
  mcpServerNames?: string[];
  /** Number of enabled MCP servers */
  mcpEnabledCount?: number;
  /** Whether all MCP servers are enabled */
  mcpAllEnabled?: boolean;
  /** Toggle all MCP servers */
  onMcpToggleAll?: (enabled: boolean) => void;
  /** Check if specific server is enabled */
  isMcpServerEnabled?: (serverName: string) => boolean;
  /** Toggle specific server */
  onMcpServerToggle?: (serverName: string, enabled: boolean) => void;
  /** Whether MCP section should be shown (desktop only) */
  showMcp?: boolean;
  /** Disable all toggles */
  disabled?: boolean;
  /** Additional class names */
  className?: string;
}

/**
 * ToolsPopover - Consolidated popover for AI tool toggles
 *
 * Contains:
 * - Web search toggle
 * - Write/Read only mode toggle
 * - Workspace context toggle
 * - MCP server toggles (desktop only) - per-server control
 */
export function ToolsPopover({
  webSearchEnabled = false,
  onWebSearchToggle,
  writeMode = true,
  onWriteModeToggle,
  showPageTree = false,
  onShowPageTreeToggle,
  mcpRunningServers = 0,
  mcpServerNames = [],
  mcpEnabledCount = 0,
  mcpAllEnabled = false,
  onMcpToggleAll,
  isMcpServerEnabled,
  onMcpServerToggle,
  showMcp = false,
  disabled = false,
  className,
}: ToolsPopoverProps) {
  // Track whether MCP servers section is expanded
  const [mcpExpanded, setMcpExpanded] = useState(false);

  // Count active tools for badge (exclude writeMode since it's default true)
  const activeCount = [
    webSearchEnabled,
    showPageTree,
    showMcp && mcpEnabledCount > 0,
  ].filter(Boolean).length;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          className={cn(
            'h-8 px-2 gap-1.5 hover:bg-transparent dark:hover:bg-transparent hover:text-foreground',
            activeCount > 0
              ? 'text-muted-foreground'
              : 'text-muted-foreground/40',
            className
          )}
        >
          <Wrench className="h-4 w-4" />
          <span className="text-xs">Tools</span>
          {activeCount > 0 && (
            <Badge
              variant="secondary"
              className="h-4 min-w-4 px-1 text-[10px] font-medium"
            >
              {activeCount}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-64 p-2"
        sideOffset={8}
      >
        <div className="space-y-1">
          {/* Web Search Toggle */}
          <div
            className={cn(
              'flex items-center justify-between w-full px-2 py-2 rounded-md transition-colors',
              'hover:bg-accent hover:text-accent-foreground',
              disabled && 'opacity-50 cursor-not-allowed'
            )}
          >
            <div className="flex items-center gap-2">
              <Globe className={cn(
                'h-4 w-4',
                webSearchEnabled ? 'text-foreground' : 'text-muted-foreground'
              )} />
              <span className={cn(
                'text-sm',
                webSearchEnabled ? 'text-foreground' : 'text-muted-foreground'
              )}>
                Web Search
              </span>
            </div>
            <Switch
              checked={webSearchEnabled}
              onCheckedChange={onWebSearchToggle}
              disabled={disabled}
              className="scale-75"
            />
          </div>

          {/* Write/Read Only Toggle */}
          <div
            className={cn(
              'flex items-center justify-between w-full px-2 py-2 rounded-md transition-colors',
              'hover:bg-accent hover:text-accent-foreground',
              disabled && 'opacity-50 cursor-not-allowed'
            )}
          >
            <div className="flex items-center gap-2">
              {writeMode ? (
                <Pencil className="h-4 w-4 text-foreground" />
              ) : (
                <PencilOff className="h-4 w-4 text-muted-foreground" />
              )}
              <span className={cn(
                'text-sm',
                writeMode ? 'text-foreground' : 'text-muted-foreground'
              )}>
                {writeMode ? 'Write Mode' : 'Read Only'}
              </span>
            </div>
            <Switch
              checked={writeMode}
              onCheckedChange={onWriteModeToggle}
              disabled={disabled}
              className="scale-75"
            />
          </div>

          {/* Page Tree Context Toggle */}
          <div
            className={cn(
              'flex items-center justify-between w-full px-2 py-2 rounded-md transition-colors',
              'hover:bg-accent hover:text-accent-foreground',
              disabled && 'opacity-50 cursor-not-allowed'
            )}
          >
            <div className="flex items-center gap-2">
              <GitBranch className={cn(
                'h-4 w-4',
                showPageTree ? 'text-foreground' : 'text-muted-foreground'
              )} />
              <span className={cn(
                'text-sm',
                showPageTree ? 'text-foreground' : 'text-muted-foreground'
              )}>
                Page Tree Context
              </span>
            </div>
            <Switch
              checked={showPageTree}
              onCheckedChange={onShowPageTreeToggle}
              disabled={disabled}
              className="scale-75"
            />
          </div>

          {/* MCP Servers (Desktop Only) */}
          {showMcp && (
            <>
              <div className="h-px bg-border my-2" />

              {/* MCP Header - Collapsible with All toggle */}
              <div
                className={cn(
                  'flex items-center justify-between w-full px-2 py-2 rounded-md transition-colors',
                  mcpRunningServers > 0 && 'hover:bg-accent hover:text-accent-foreground cursor-pointer',
                  (disabled || mcpRunningServers === 0) && 'opacity-50'
                )}
                onClick={() => mcpRunningServers > 0 && setMcpExpanded(!mcpExpanded)}
              >
                <div className="flex items-center gap-2">
                  {mcpRunningServers > 0 ? (
                    mcpExpanded ? (
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    )
                  ) : (
                    <Server className="h-4 w-4 text-muted-foreground" />
                  )}
                  <span className={cn(
                    'text-sm',
                    mcpEnabledCount > 0 ? 'text-foreground' : 'text-muted-foreground'
                  )}>
                    MCP Servers
                  </span>
                  {mcpRunningServers > 0 && (
                    <Badge
                      variant={mcpEnabledCount > 0 ? 'default' : 'secondary'}
                      className="h-4 text-[10px] px-1"
                    >
                      {mcpEnabledCount}/{mcpRunningServers}
                    </Badge>
                  )}
                </div>
                {mcpRunningServers > 0 && (
                  <Switch
                    checked={mcpAllEnabled}
                    onCheckedChange={(checked) => {
                      onMcpToggleAll?.(checked);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    disabled={disabled}
                    className="scale-75"
                  />
                )}
              </div>

              {/* No servers message */}
              {mcpRunningServers === 0 && (
                <p className="text-xs text-muted-foreground px-2 pb-1">
                  No MCP servers running
                </p>
              )}

              {/* Individual Server Toggles */}
              {mcpExpanded && mcpRunningServers > 0 && (
                <div className="pl-4 space-y-1">
                  {mcpServerNames.map((serverName) => {
                    const isEnabled = isMcpServerEnabled?.(serverName) ?? true;
                    return (
                      <div
                        key={serverName}
                        className={cn(
                          'flex items-center justify-between w-full px-2 py-1.5 rounded-md transition-colors',
                          'hover:bg-accent hover:text-accent-foreground',
                          disabled && 'opacity-50 cursor-not-allowed'
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <Server className={cn(
                            'h-3.5 w-3.5',
                            isEnabled ? 'text-foreground' : 'text-muted-foreground'
                          )} />
                          <span className={cn(
                            'text-xs truncate max-w-[140px]',
                            isEnabled ? 'text-foreground' : 'text-muted-foreground'
                          )}>
                            {serverName}
                          </span>
                        </div>
                        <Switch
                          checked={isEnabled}
                          onCheckedChange={(checked) => {
                            onMcpServerToggle?.(serverName, checked);
                          }}
                          disabled={disabled}
                          className="scale-[0.65]"
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export default ToolsPopover;
