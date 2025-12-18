'use client';

import React from 'react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip';
import { Mic, Globe, Pencil, PencilOff, GitBranch } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ProviderModelSelector } from '@/components/ai/chat/input/ProviderModelSelector';

export interface InputFooterProps {
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
 * - Web search toggle (left)
 * - Write/Read only toggle (left)
 * - Workspace context toggle (left)
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
      {/* Left group */}
      <div className="flex items-center gap-1">
        {/* Web search toggle */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              onClick={onWebSearchToggle}
              disabled={disabled}
              className={cn(
                'h-8 px-2 gap-1.5 hover:bg-transparent dark:hover:bg-transparent hover:text-foreground',
                webSearchEnabled
                  ? 'text-muted-foreground'
                  : 'text-muted-foreground/20'
              )}
            >
              <Globe className="h-4 w-4" />
              <span className={cn('text-xs', !webSearchEnabled && 'line-through')}>
                Web
              </span>
              <span className="sr-only">
                {webSearchEnabled ? 'Disable web search' : 'Enable web search'}
              </span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            {webSearchEnabled ? 'Disable web search' : 'Enable web search'}
          </TooltipContent>
        </Tooltip>

        {/* Write/Read only toggle */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              onClick={onWriteModeToggle}
              disabled={disabled}
              className={cn(
                'h-8 px-2 gap-1.5 hover:bg-transparent dark:hover:bg-transparent hover:text-foreground',
                writeMode
                  ? 'text-muted-foreground'
                  : 'text-muted-foreground/20'
              )}
            >
              {writeMode ? (
                <Pencil className="h-4 w-4" />
              ) : (
                <PencilOff className="h-4 w-4" />
              )}
              <span className="text-xs">{writeMode ? 'Write' : 'Read only'}</span>
              <span className="sr-only">
                {writeMode ? 'Switch to read only mode' : 'Switch to write mode'}
              </span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            {writeMode ? 'Switch to read only mode' : 'Switch to write mode'}
          </TooltipContent>
        </Tooltip>

        {/* Workspace context toggle */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              onClick={onShowPageTreeToggle}
              disabled={disabled}
              className={cn(
                'h-8 px-2 gap-1.5 hover:bg-transparent dark:hover:bg-transparent hover:text-foreground',
                showPageTree
                  ? 'text-muted-foreground'
                  : 'text-muted-foreground/20'
              )}
            >
              <GitBranch className="h-4 w-4" />
              <span className={cn('text-xs', !showPageTree && 'line-through')}>
                Context
              </span>
              <span className="sr-only">
                {showPageTree ? 'Disable workspace context' : 'Enable workspace context'}
              </span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            {showPageTree ? 'Disable workspace structure context' : 'Enable workspace structure context'}
          </TooltipContent>
        </Tooltip>
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
