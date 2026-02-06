'use client';

import React from 'react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip';
import { Mic, AudioLines, MicOff } from 'lucide-react';
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
  /** Callback when mic button is clicked (basic speech-to-text) */
  onMicClick?: () => void;
  /** Whether microphone is currently listening (basic STT) */
  isListening?: boolean;
  /** Whether microphone is supported by the browser */
  isMicSupported?: boolean;
  /** Callback when voice mode button is clicked */
  onVoiceModeClick?: () => void;
  /** Whether voice mode is currently active */
  isVoiceModeActive?: boolean;
  /** Whether voice mode is available (user has OpenAI key) */
  isVoiceModeAvailable?: boolean;
  /** Error message from microphone/speech recognition */
  micError?: string | null;
  /** Callback to clear the mic error */
  onClearMicError?: () => void;
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
  mcpRunningServers = 0,
  mcpServerNames = [],
  mcpEnabledCount = 0,
  mcpAllEnabled = false,
  onMcpToggleAll,
  isMcpServerEnabled,
  onMcpServerToggle,
  showMcp = false,
  onMicClick,
  isListening = false,
  isMicSupported = true,
  onVoiceModeClick,
  isVoiceModeActive = false,
  isVoiceModeAvailable = false,
  micError,
  onClearMicError,
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
          mcpRunningServers={mcpRunningServers}
          mcpServerNames={mcpServerNames}
          mcpEnabledCount={mcpEnabledCount}
          mcpAllEnabled={mcpAllEnabled}
          onMcpToggleAll={onMcpToggleAll}
          isMcpServerEnabled={isMcpServerEnabled}
          onMcpServerToggle={onMcpServerToggle}
          showMcp={showMcp}
          disabled={disabled}
        />
      </div>

      {/* Right group - Provider/Model Selector + Mic */}
      <div className="flex items-center gap-1 min-w-0">
        {!hideModelSelector && (
          <ProviderModelSelector
            provider={selectedProvider}
            model={selectedModel}
            onChange={onProviderModelChange}
            disabled={disabled}
          />
        )}

        {/* Voice Mode button (OpenAI STT/TTS) */}
        {isVoiceModeAvailable && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={onVoiceModeClick}
                disabled={disabled}
                className={cn(
                  'h-8 w-8 p-0 transition-all duration-200 hover:bg-transparent dark:hover:bg-transparent',
                  isVoiceModeActive
                    ? 'text-primary'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <AudioLines className="h-4 w-4" />
                <span className="sr-only">
                  {isVoiceModeActive ? 'Exit voice mode' : 'Enter voice mode'}
                </span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {isVoiceModeActive ? 'Exit voice mode' : 'Voice mode (hands-free)'}
            </TooltipContent>
          </Tooltip>
        )}

        {/* Mic button (basic STT) */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              onClick={micError ? onClearMicError : onMicClick}
              disabled={disabled || !isMicSupported}
              className={cn(
                'h-8 w-8 p-0 transition-all duration-200 hover:bg-transparent dark:hover:bg-transparent',
                'hidden sm:inline-flex',
                micError
                  ? 'text-destructive hover:text-destructive/80'
                  : isListening
                    ? 'animate-pulse text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {micError ? (
                <MicOff className="h-4 w-4" />
              ) : (
                <Mic className="h-4 w-4" />
              )}
              <span className="sr-only">
                {micError
                  ? 'Microphone error - click to dismiss'
                  : isListening
                    ? 'Stop listening'
                    : 'Voice input'}
              </span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" className={cn(micError && 'max-w-64')}>
            {micError
              ? micError
              : !isMicSupported
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
