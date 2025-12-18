'use client';

import React from 'react';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Wrench, Globe, Pencil, PencilOff, GitBranch, Server } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface ToolsPopoverProps {
  /** Whether web search is enabled */
  webSearchEnabled?: boolean;
  /** Callback when web search is toggled */
  onWebSearchToggle?: () => void;
  /** Whether write mode is active (true = write, false = read only) */
  writeMode?: boolean;
  /** Callback when write mode is toggled */
  onWriteModeToggle?: () => void;
  /** Whether to show workspace page tree context to AI */
  showPageTree?: boolean;
  /** Callback when page tree context is toggled */
  onShowPageTreeToggle?: () => void;
  /** Whether MCP is enabled for this conversation */
  mcpEnabled?: boolean;
  /** Callback when MCP is toggled */
  onMcpToggle?: (enabled: boolean) => void;
  /** Number of running MCP servers */
  mcpRunningServers?: number;
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
 * - MCP tools toggle (desktop only)
 */
export function ToolsPopover({
  webSearchEnabled = false,
  onWebSearchToggle,
  writeMode = true,
  onWriteModeToggle,
  showPageTree = false,
  onShowPageTreeToggle,
  mcpEnabled = false,
  onMcpToggle,
  mcpRunningServers = 0,
  showMcp = false,
  disabled = false,
  className,
}: ToolsPopoverProps) {
  // Count active tools for badge (exclude writeMode since it's default true)
  const activeCount = [
    webSearchEnabled,
    showPageTree,
    showMcp && mcpEnabled,
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

          {/* MCP Toggle (Desktop Only) */}
          {showMcp && (
            <>
              <div className="h-px bg-border my-2" />
              <div
                className={cn(
                  'flex items-center justify-between w-full px-2 py-2 rounded-md transition-colors',
                  'hover:bg-accent hover:text-accent-foreground',
                  (disabled || mcpRunningServers === 0) && 'opacity-50 cursor-not-allowed'
                )}
              >
                <div className="flex items-center gap-2">
                  <Server className={cn(
                    'h-4 w-4',
                    mcpEnabled ? 'text-foreground' : 'text-muted-foreground'
                  )} />
                  <span className={cn(
                    'text-sm',
                    mcpEnabled ? 'text-foreground' : 'text-muted-foreground'
                  )}>
                    MCP Tools
                  </span>
                  {mcpRunningServers > 0 && mcpEnabled && (
                    <Badge variant="default" className="h-4 text-[10px] px-1">
                      {mcpRunningServers}
                    </Badge>
                  )}
                </div>
                <Switch
                  checked={mcpEnabled}
                  onCheckedChange={onMcpToggle}
                  disabled={disabled || mcpRunningServers === 0}
                  className="scale-75"
                />
              </div>
              {mcpRunningServers === 0 && (
                <p className="text-xs text-muted-foreground px-2 pb-1">
                  No MCP servers running
                </p>
              )}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export default ToolsPopover;
