'use client';

import React from 'react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip';
import { Mic, Globe, ChevronDown, Pencil, PencilOff } from 'lucide-react';
import { cn } from '@/lib/utils';

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
  /** Callback when provider selector is clicked */
  onProviderClick?: () => void;
  /** Callback when model selector is clicked */
  onModelClick?: () => void;
  /** Currently selected provider name */
  selectedProvider?: string;
  /** Currently selected model name */
  selectedModel?: string;
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
 * - Provider selector (right)
 * - Model selector (right)
 */
export function InputFooter({
  webSearchEnabled = false,
  onWebSearchToggle,
  writeMode = true,
  onWriteModeToggle,
  onMicClick,
  onProviderClick,
  onModelClick,
  selectedProvider = 'OpenAI',
  selectedModel = 'GPT-4o',
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
              className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
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
              className={cn(
                'h-8 px-2 gap-1.5 hover:text-muted-foreground',
                webSearchEnabled
                  ? 'text-muted-foreground'
                  : 'text-muted-foreground/20'
              )}
            >
              <Globe className="h-4 w-4" />
              <span className={cn('text-xs', !webSearchEnabled && 'line-through')}>
                Web
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
              className={cn(
                'h-8 px-2 gap-1.5 hover:text-muted-foreground',
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

      {/* Right group */}
      <div className="flex items-center gap-1">
        {/* Provider selector */}
        <Button
          variant="ghost"
          size="sm"
          onClick={onProviderClick}
          className="h-8 px-2 gap-1 text-muted-foreground hover:text-foreground"
        >
          <span className="text-xs">{selectedProvider}</span>
          <ChevronDown className="h-3 w-3" />
        </Button>

        {/* Model selector */}
        <Button
          variant="ghost"
          size="sm"
          onClick={onModelClick}
          className="h-8 px-2 gap-1 text-muted-foreground hover:text-foreground"
        >
          <span className="text-xs">{selectedModel}</span>
          <ChevronDown className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}

export default InputFooter;
