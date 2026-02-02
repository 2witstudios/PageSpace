'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Bold,
  Italic,
  Code,
  List,
  Paperclip,
  Smile,
  AtSign,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { EmojiPickerPopover } from '@/components/ui/emoji-picker';

export interface ChannelInputFooterProps {
  /** Callback when formatting button clicked */
  onFormatClick?: (format: 'bold' | 'italic' | 'code' | 'list') => void;
  /** Callback when attachment button clicked */
  onAttachmentClick?: () => void;
  /** Callback when emoji is selected */
  onEmojiSelect?: (emoji: string) => void;
  /** Callback when mention button clicked */
  onMentionClick?: () => void;
  /** Whether attachments are supported */
  attachmentsEnabled?: boolean;
  /** Whether input is disabled */
  disabled?: boolean;
  /** Additional class names */
  className?: string;
}

interface FormatButton {
  id: 'bold' | 'italic' | 'code' | 'list';
  icon: typeof Bold;
  label: string;
  shortcut: string;
}

const FORMAT_BUTTONS: FormatButton[] = [
  { id: 'bold', icon: Bold, label: 'Bold', shortcut: '⌘B' },
  { id: 'italic', icon: Italic, label: 'Italic', shortcut: '⌘I' },
  { id: 'code', icon: Code, label: 'Code', shortcut: '⌘E' },
  { id: 'list', icon: List, label: 'List', shortcut: '⌘⇧L' },
];

/**
 * ChannelInputFooter - Footer actions for channel message input
 *
 * Contains:
 * - Formatting buttons (bold, italic, code, list) in a popover
 * - Attachment button (future: file uploads)
 * - Emoji picker trigger
 * - Mention shortcut button
 *
 * Designed to complement the floating input card design.
 */
export function ChannelInputFooter({
  onFormatClick,
  onAttachmentClick,
  onEmojiSelect,
  onMentionClick,
  attachmentsEnabled = false,
  disabled = false,
  className,
}: ChannelInputFooterProps) {
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  return (
    <div
      className={cn(
        'flex items-center justify-between',
        'px-3 py-2',
        'border-t border-border/40',
        className
      )}
    >
      {/* Left group - Formatting & Actions */}
      <div className="flex items-center gap-0.5">
        {/* Formatting popover */}
        <Popover>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  className={cn(
                    'h-8 w-8 p-0',
                    'text-muted-foreground hover:text-foreground',
                    'hover:bg-muted/50'
                  )}
                >
                  <Bold className="h-4 w-4" />
                  <span className="sr-only">Formatting</span>
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="top">Formatting</TooltipContent>
          </Tooltip>
          <PopoverContent
            side="top"
            align="start"
            className="w-auto p-1"
            sideOffset={8}
          >
            <div className="flex items-center gap-0.5">
              {FORMAT_BUTTONS.map((btn) => (
                <Tooltip key={btn.id}>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onFormatClick?.(btn.id)}
                      disabled={disabled}
                      className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
                    >
                      <btn.icon className="h-4 w-4" />
                      <span className="sr-only">{btn.label}</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    {btn.label} <span className="text-muted-foreground ml-1">{btn.shortcut}</span>
                  </TooltipContent>
                </Tooltip>
              ))}
            </div>
          </PopoverContent>
        </Popover>

        {/* Divider */}
        <div className="w-px h-4 bg-border/60 mx-1" />

        {/* Mention button */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              onClick={onMentionClick}
              disabled={disabled}
              className={cn(
                'h-8 w-8 p-0',
                'text-muted-foreground hover:text-foreground',
                'hover:bg-muted/50'
              )}
            >
              <AtSign className="h-4 w-4" />
              <span className="sr-only">Mention</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">Mention someone</TooltipContent>
        </Tooltip>

        {/* Emoji picker */}
        <EmojiPickerPopover
          open={emojiPickerOpen}
          onOpenChange={setEmojiPickerOpen}
          onEmojiSelect={(emoji) => {
            onEmojiSelect?.(emoji);
            setEmojiPickerOpen(false);
          }}
          side="top"
          align="start"
          showQuickReactions={false}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled}
                className={cn(
                  'h-8 w-8 p-0',
                  'text-muted-foreground hover:text-foreground',
                  'hover:bg-muted/50'
                )}
              >
                <Smile className="h-4 w-4" />
                <span className="sr-only">Emoji</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Add emoji</TooltipContent>
          </Tooltip>
        </EmojiPickerPopover>
      </div>

      {/* Right group - Attachments (future) */}
      <div className="flex items-center gap-1">
        {attachmentsEnabled && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={onAttachmentClick}
                disabled={disabled}
                className={cn(
                  'h-8 w-8 p-0',
                  'text-muted-foreground hover:text-foreground',
                  'hover:bg-muted/50'
                )}
              >
                <Paperclip className="h-4 w-4" />
                <span className="sr-only">Attach file</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Attach file</TooltipContent>
          </Tooltip>
        )}

        {/* Markdown hint */}
        <span className="text-xs text-muted-foreground/60 hidden sm:inline">
          Markdown supported
        </span>
      </div>
    </div>
  );
}

export default ChannelInputFooter;
