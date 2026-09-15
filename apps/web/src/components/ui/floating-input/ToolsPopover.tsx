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
import { Wrench, Globe, Pencil, PencilOff, GitBranch, Server, ChevronDown, ChevronRight, Image as ImageIcon, Lock, ShieldCheck, X } from 'lucide-react';
import { formatToolName } from '@/lib/ai/tools/tool-labels';
import { cn } from '@/lib/utils';

export interface ToolsPopoverProps {
  /** Whether web search is enabled */
  webSearchEnabled?: boolean;
  /** Callback when web search is toggled */
  onWebSearchToggle?: (enabled: boolean) => void;
  /** Whether image generation is enabled */
  imageGenEnabled?: boolean;
  /** Callback when image generation is toggled */
  onImageGenToggle?: (enabled: boolean) => void;
  /** Whether the user may use image generation (app admins only during rollout). When false, the row is locked. */
  canUseImageGen?: boolean;
  /** Whether write mode is active (true = write, false = read only) */
  writeMode?: boolean;
  /** Callback when write mode is toggled */
  onWriteModeToggle?: (enabled: boolean) => void;
  /**
   * Tool approvals for the user's global assistant: 'ask' pauses gated writes for
   * Allow/Deny in the chat, 'auto' never pauses. Omit to hide the row (a page
   * agent carries its own mode on its settings tab).
   */
  toolApprovalMode?: 'ask' | 'auto';
  /** Callback when the approval switch is flipped (true = ask). */
  onToolApprovalModeToggle?: (ask: boolean) => void;
  /** The user's standing "always allow" grants, revocable here. */
  trustedTools?: Array<{ id: string; toolName: string; conversationId: string | null }>;
  /** Revoke one grant by id. */
  onRevokeTrustedTool?: (grantId: string) => void;
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
  imageGenEnabled = false,
  onImageGenToggle,
  canUseImageGen = false,
  writeMode = true,
  onWriteModeToggle,
  toolApprovalMode,
  onToolApprovalModeToggle,
  trustedTools = [],
  onRevokeTrustedTool,
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
  const [trustedExpanded, setTrustedExpanded] = useState(false);
  const alwaysAllowed = trustedTools.filter((grant) => grant.conversationId === null);

  // Count active tools for badge (exclude writeMode since it's default true)
  const activeCount = [
    webSearchEnabled,
    canUseImageGen && imageGenEnabled,
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
                Web
              </span>
            </div>
            <Switch
              checked={webSearchEnabled}
              onCheckedChange={onWebSearchToggle}
              disabled={disabled}
              className="scale-75"
            />
          </div>

          {/* Image Generation Toggle (admin-only during rollout) */}
          <div
            className={cn(
              'flex items-center justify-between w-full px-2 py-2 rounded-md transition-colors',
              'hover:bg-accent hover:text-accent-foreground',
              (disabled || !canUseImageGen) && 'opacity-50 cursor-not-allowed'
            )}
            title={canUseImageGen ? undefined : 'Image generation is restricted to app administrators'}
          >
            <div className="flex items-center gap-2">
              <ImageIcon className={cn(
                'h-4 w-4',
                canUseImageGen && imageGenEnabled ? 'text-foreground' : 'text-muted-foreground'
              )} />
              <span className={cn(
                'text-sm flex items-center gap-1',
                canUseImageGen && imageGenEnabled ? 'text-foreground' : 'text-muted-foreground'
              )}>
                Image
                {!canUseImageGen && <Lock className="h-3 w-3" />}
              </span>
            </div>
            <Switch
              checked={canUseImageGen && imageGenEnabled}
              onCheckedChange={onImageGenToggle}
              disabled={disabled || !canUseImageGen}
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

          {/* Action approval (global assistant only) */}
          {toolApprovalMode !== undefined && (
            <>
              <div
                className={cn(
                  'flex items-center justify-between w-full px-2 py-2 rounded-md transition-colors',
                  'hover:bg-accent hover:text-accent-foreground',
                  disabled && 'opacity-50 cursor-not-allowed'
                )}
                data-testid="tool-approval-toggle"
              >
                <div className="flex items-center gap-2">
                  <ShieldCheck className={cn('h-4 w-4', toolApprovalMode === 'ask' ? 'text-foreground' : 'text-muted-foreground')} />
                  <span className={cn('text-sm', toolApprovalMode === 'ask' ? 'text-foreground' : 'text-muted-foreground')}>
                    Ask before actions
                  </span>
                </div>
                <Switch
                  checked={toolApprovalMode === 'ask'}
                  onCheckedChange={onToolApprovalModeToggle}
                  disabled={disabled}
                  className="scale-75"
                  aria-label="Ask before actions"
                />
              </div>
              {alwaysAllowed.length > 0 && (
                <div className="px-2 pb-1">
                  <button
                    type="button"
                    onClick={() => setTrustedExpanded((open) => !open)}
                    className="flex w-full items-center gap-1 py-1 text-xs text-muted-foreground hover:text-foreground"
                    aria-expanded={trustedExpanded}
                  >
                    {trustedExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                    Always allowed ({alwaysAllowed.length})
                  </button>
                  {trustedExpanded && (
                    <ul className="space-y-0.5 pl-4">
                      {alwaysAllowed.map((grant) => (
                        <li key={grant.id} className="flex items-center justify-between gap-2 text-xs">
                          <span className="truncate">{formatToolName(grant.toolName)}</span>
                          <button
                            type="button"
                            onClick={() => onRevokeTrustedTool?.(grant.id)}
                            disabled={disabled || !onRevokeTrustedTool}
                            className="rounded p-0.5 text-muted-foreground hover:text-destructive disabled:opacity-50"
                            aria-label={`Revoke always allow for ${formatToolName(grant.toolName)}`}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}

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
