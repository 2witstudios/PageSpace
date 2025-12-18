'use client';

import React from 'react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip';
import { Mic, Globe, Pencil, PencilOff } from 'lucide-react';
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
  /** Callback when mic button is clicked */
  onMicClick?: () => void;
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
 * - Mic button (left)
 * - Web search toggle (left)
 * - Write/Read only toggle (left)
 * - Provider/Model selector (right) - Combined popover
 */
export function InputFooter({
  webSearchEnabled = false,
  onWebSearchToggle,
  writeMode = true,
  onWriteModeToggle,
  onMicClick,
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
        {/* Mic button */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              onClick={onMicClick}
              disabled={disabled}
              className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground hover:bg-transparent dark:hover:bg-transparent"
            >
              <Mic className="h-4 w-4" />
              <span className="sr-only">Voice input</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">Voice input</TooltipContent>
        </Tooltip>

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
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            {writeMode ? 'Switch to read only mode' : 'Switch to write mode'}
          </TooltipContent>
        </Tooltip>
      </div>

      {/* Right group - Provider/Model Selector */}
      {!hideModelSelector && (
        <ProviderModelSelector
          provider={selectedProvider}
          model={selectedModel}
          onChange={onProviderModelChange}
          disabled={disabled}
        />
      )}
    </div>
  );
}

export default InputFooter;
