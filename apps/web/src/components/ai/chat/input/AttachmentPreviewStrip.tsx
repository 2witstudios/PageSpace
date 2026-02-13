'use client';

import React from 'react';
import { X, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ImageAttachment } from '@/lib/ai/shared/hooks/useImageAttachments';

interface AttachmentPreviewStripProps {
  attachments: ImageAttachment[];
  onRemove: (id: string) => void;
  className?: string;
}

/**
 * AttachmentPreviewStrip — Horizontal row of image thumbnails above the textarea.
 * Shows compact pills with preview, filename, and remove button.
 */
export function AttachmentPreviewStrip({
  attachments,
  onRemove,
  className,
}: AttachmentPreviewStripProps) {
  if (attachments.length === 0) return null;

  return (
    <div
      className={cn(
        'flex items-center gap-2 px-3 pt-2 overflow-x-auto scrollbar-thin',
        className
      )}
    >
      {attachments.map((attachment) => (
        <div
          key={attachment.id}
          className={cn(
            'flex items-center gap-1.5 h-8 pl-1 pr-1.5 rounded-md shrink-0',
            'bg-muted/50 border border-border/50',
            'text-xs text-muted-foreground',
            'transition-colors hover:bg-muted',
            'animate-in fade-in duration-200'
          )}
        >
          {/* Thumbnail */}
          <div className="relative h-6 w-6 shrink-0 rounded overflow-hidden bg-muted">
            {attachment.processing ? (
              <div className="flex items-center justify-center h-full w-full">
                <Loader2 className="h-3 w-3 animate-spin" />
              </div>
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={attachment.previewUrl}
                alt={attachment.filename}
                className="h-full w-full object-cover"
              />
            )}
          </div>

          {/* Filename */}
          <span className="max-w-[80px] truncate">{attachment.filename}</span>

          {/* Remove button */}
          <button
            type="button"
            onClick={() => onRemove(attachment.id)}
            className={cn(
              'flex items-center justify-center h-4 w-4 shrink-0 rounded-full',
              'text-muted-foreground/70 hover:text-foreground hover:bg-muted-foreground/20',
              'transition-colors'
            )}
            aria-label={`Remove ${attachment.filename}`}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
