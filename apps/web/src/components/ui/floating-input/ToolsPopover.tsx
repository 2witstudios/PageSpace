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
import { useMobile } from '@/hooks/useMobile';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';

export interface ToolsPopoverProps {
  webSearchEnabled?: boolean;
  onWebSearchToggle?: (enabled: boolean) => void;
  writeMode?: boolean;
  onWriteModeToggle?: (enabled: boolean) => void;
  showPageTree?: boolean;
  onShowPageTreeToggle?: (enabled: boolean) => void;
  mcpRunningServers?: number;
  mcpServerNames?: string[];
  mcpEnabledCount?: number;
  mcpAllEnabled?: boolean;
  onMcpToggleAll?: (enabled: boolean) => void;
  isMcpServerEnabled?: (serverName: string) => boolean;
  onMcpServerToggle?: (serverName: string, enabled: boolean) => void;
  showMcp?: boolean;
  disabled?: boolean;
  className?: string;
}

function ToolToggleRow({
  icon,
  label,
  checked,
  onCheckedChange,
  disabled,
  mobile,
}: {
  icon: React.ReactNode;
  label: string;
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  mobile?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-between w-full rounded-md transition-colors',
        mobile ? 'px-3 py-3' : 'px-2 py-2',
        !mobile && 'hover:bg-accent hover:text-accent-foreground',
        disabled && 'opacity-50 cursor-not-allowed'
      )}
    >
      <div className="flex items-center gap-2">
        <span className={cn(checked ? 'text-foreground' : 'text-muted-foreground')}>
          {icon}
        </span>
        <span className={cn(
          mobile ? 'text-sm font-medium' : 'text-sm',
          checked ? 'text-foreground' : 'text-muted-foreground'
        )}>
          {label}
        </span>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        className={mobile ? '' : 'scale-75'}
      />
    </div>
  );
}

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
  const [mcpExpanded, setMcpExpanded] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const isMobile = useMobile();

  const activeCount = [
    webSearchEnabled,
    showPageTree,
    showMcp && mcpEnabledCount > 0,
  ].filter(Boolean).length;

  const triggerButton = (
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
      onClick={isMobile ? () => setSheetOpen(true) : undefined}
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
  );

  const mcpSection = showMcp && (
    <>
      <div className="h-px bg-border my-2" />
      <div
        className={cn(
          'flex items-center justify-between w-full rounded-md transition-colors',
          isMobile ? 'px-3 py-3' : 'px-2 py-2',
          mcpRunningServers > 0 && (isMobile ? 'active:bg-accent' : 'hover:bg-accent hover:text-accent-foreground cursor-pointer'),
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
            isMobile ? 'text-sm font-medium' : 'text-sm',
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
            onCheckedChange={(checked) => onMcpToggleAll?.(checked)}
            onClick={(e) => e.stopPropagation()}
            disabled={disabled}
            className={isMobile ? '' : 'scale-75'}
          />
        )}
      </div>

      {mcpRunningServers === 0 && (
        <p className={cn('text-xs text-muted-foreground pb-1', isMobile ? 'px-3' : 'px-2')}>
          No MCP servers running
        </p>
      )}

      {mcpExpanded && mcpRunningServers > 0 && (
        <div className={cn('space-y-1', isMobile ? 'pl-5' : 'pl-4')}>
          {mcpServerNames.map((serverName) => {
            const isEnabled = isMcpServerEnabled?.(serverName) ?? true;
            return (
              <div
                key={serverName}
                className={cn(
                  'flex items-center justify-between w-full rounded-md transition-colors',
                  isMobile ? 'px-3 py-2.5' : 'px-2 py-1.5',
                  !isMobile && 'hover:bg-accent hover:text-accent-foreground',
                  disabled && 'opacity-50 cursor-not-allowed'
                )}
              >
                <div className="flex items-center gap-2">
                  <Server className={cn(
                    'h-3.5 w-3.5',
                    isEnabled ? 'text-foreground' : 'text-muted-foreground'
                  )} />
                  <span className={cn(
                    'text-xs truncate',
                    isMobile ? 'max-w-[200px]' : 'max-w-[140px]',
                    isEnabled ? 'text-foreground' : 'text-muted-foreground'
                  )}>
                    {serverName}
                  </span>
                </div>
                <Switch
                  checked={isEnabled}
                  onCheckedChange={(checked) => onMcpServerToggle?.(serverName, checked)}
                  disabled={disabled}
                  className={isMobile ? 'scale-[0.85]' : 'scale-[0.65]'}
                />
              </div>
            );
          })}
        </div>
      )}
    </>
  );

  // Mobile: bottom sheet
  if (isMobile) {
    return (
      <>
        {triggerButton}

        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetContent
            side="bottom"
            className="rounded-t-2xl max-h-[70vh] pb-[calc(1rem+env(safe-area-inset-bottom))]"
          >
            <SheetHeader className="px-5 pt-3 pb-0">
              <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-muted-foreground/30" />
              <SheetTitle className="text-base">AI Tools</SheetTitle>
              <SheetDescription className="sr-only">Configure AI tool settings</SheetDescription>
            </SheetHeader>

            <div className="overflow-y-auto px-5 pb-4 mt-2">
              <div className="space-y-0.5">
                <ToolToggleRow
                  icon={<Globe className="h-5 w-5" />}
                  label="Web Search"
                  checked={webSearchEnabled}
                  onCheckedChange={onWebSearchToggle}
                  disabled={disabled}
                  mobile
                />
                <ToolToggleRow
                  icon={writeMode ? <Pencil className="h-5 w-5" /> : <PencilOff className="h-5 w-5" />}
                  label={writeMode ? 'Write Mode' : 'Read Only'}
                  checked={writeMode}
                  onCheckedChange={onWriteModeToggle}
                  disabled={disabled}
                  mobile
                />
                <ToolToggleRow
                  icon={<GitBranch className="h-5 w-5" />}
                  label="Page Tree Context"
                  checked={showPageTree}
                  onCheckedChange={onShowPageTreeToggle}
                  disabled={disabled}
                  mobile
                />
              </div>

              {mcpSection}
            </div>
          </SheetContent>
        </Sheet>
      </>
    );
  }

  // Desktop: popover
  return (
    <Popover>
      <PopoverTrigger asChild>
        {triggerButton}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-64 p-2"
        sideOffset={8}
      >
        <div className="space-y-1">
          <ToolToggleRow
            icon={<Globe className="h-4 w-4" />}
            label="Web Search"
            checked={webSearchEnabled}
            onCheckedChange={onWebSearchToggle}
            disabled={disabled}
          />
          <ToolToggleRow
            icon={writeMode ? <Pencil className="h-4 w-4" /> : <PencilOff className="h-4 w-4" />}
            label={writeMode ? 'Write Mode' : 'Read Only'}
            checked={writeMode}
            onCheckedChange={onWriteModeToggle}
            disabled={disabled}
          />
          <ToolToggleRow
            icon={<GitBranch className="h-4 w-4" />}
            label="Page Tree Context"
            checked={showPageTree}
            onCheckedChange={onShowPageTreeToggle}
            disabled={disabled}
          />

          {mcpSection}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export default ToolsPopover;
