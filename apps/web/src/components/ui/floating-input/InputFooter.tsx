'use client';

import React from 'react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip';
import { Mic } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ProviderModelSelector } from '@/components/ai/chat/input/ProviderModelSelector';
import { ToolsPopover } from './ToolsPopover';

export interface InputFooterProps {
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
  /** Whether MCP is enabled for this conversation */
  mcpEnabled?: boolean;
  /** Callback when MCP is toggled */
  onMcpToggle?: (enabled: boolean) => void;
  /** Number of running MCP servers */
  mcpRunningServers?: number;
  /** Whether MCP section should be shown (desktop only) */
  showMcp?: boolean;
  /** Callback when mic button is clicked */
  onMicClick?: () => void;
  /** Whether microphone is currently listening */
  isListening?: boolean;
  /** Whether microphone is supported by the browser */
  isMicSupported?: boolean;
  /** Currently selected provider */
  selectedProvider?: string | null;
  /** Currently selected model */
  selectedModel?: string | null;
  /** Callback when provider/model changes */
  onProviderModelChange?: (provider: string, model: string) => void;
  /** Hide the provider/model selector (for compact layouts) */
  hideModelSelector?: boolean;
  /** Disable the selector (e.g., during streaming) */
  disabled?: boolean;
  /** Additional class names */
  className?: string;
}

/**
 * InputFooter - Footer menu for the floating input card.
 *
 * Contains:
 * - Tools popover (left) - web search, write mode, context, MCP toggles
 * - Provider/Model selector (right)
 * - Mic button (right, after model selector)
 */
export function InputFooter({
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
  onMicClick,
  isListening = false,
  isMicSupported = true,
  selectedProvider,
  selectedModel,
  onProviderModelChange,
  hideModelSelector = false,
  disabled = false,
  className,
}: InputFooterProps) {
  return (
    <div
      className={cn(
        'flex items-center justify-between',
        'px-3 py-2',
        className
      )}
    >
      {/* Left group - Tools popover */}
      <div className="flex items-center gap-1">
        <ToolsPopover
          webSearchEnabled={webSearchEnabled}
          onWebSearchToggle={onWebSearchToggle}
          writeMode={writeMode}
          onWriteModeToggle={onWriteModeToggle}
          showPageTree={showPageTree}
          onShowPageTreeToggle={onShowPageTreeToggle}
          mcpEnabled={mcpEnabled}
          onMcpToggle={onMcpToggle}
          mcpRunningServers={mcpRunningServers}
          showMcp={showMcp}
          disabled={disabled}
        />
      </div>

      {/* Right group - Provider/Model Selector + Mic */}
      <div className="flex items-center gap-1">
        {!hideModelSelector && (
          <ProviderModelSelector
            provider={selectedProvider}
            model={selectedModel}
            onChange={onProviderModelChange}
            disabled={disabled}
          />
        )}

        {/* Mic button */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              onClick={onMicClick}
              disabled={disabled || !isMicSupported}
              className={cn(
                'h-8 w-8 p-0 transition-all duration-200 hover:bg-transparent dark:hover:bg-transparent',
                isListening
                  ? 'animate-pulse text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Mic className="h-4 w-4" />
              <span className="sr-only">
                {isListening ? 'Stop listening' : 'Voice input'}
              </span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            {!isMicSupported
              ? 'Voice input not supported'
              : isListening
                ? 'Stop listening'
                : 'Voice input'}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

export default InputFooter;
