'use client';

import React, { useState } from 'react';
import { cn } from '@/lib/utils';
import { ImageOff } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import type { FilePart } from './message-types';

interface ImageMessageContentProps {
  parts: FilePart[];
  compact?: boolean;
}

/**
 * ImageMessageContent — Renders a group of image attachments in a message.
 * Supports grid layout for multiple images and click-to-expand lightbox.
 */
export const ImageMessageContent: React.FC<ImageMessageContentProps> = React.memo(({ parts, compact = false }) => {
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [errorUrls, setErrorUrls] = useState<Set<string>>(new Set());

  const maxSize = compact ? 'max-w-[120px] max-h-[120px]' : 'max-w-[200px] max-h-[200px]';

  return (
    <>
      <div
        className={cn(
          'flex flex-wrap gap-2',
          compact ? 'mb-1' : 'mb-2 ml-2 sm:ml-8'
        )}
      >
        {parts.map((part, index) => {
          const key = `${part.url?.slice(0, 40) || 'img'}-${index}`;
          const hasError = errorUrls.has(part.url);

          if (hasError || !part.url) {
            return (
              <div
                key={key}
                className={cn(
                  'flex items-center justify-center rounded-md border border-border bg-muted/50',
                  compact ? 'h-[60px] w-[60px]' : 'h-[100px] w-[100px]'
                )}
              >
                <ImageOff className="h-5 w-5 text-muted-foreground" />
              </div>
            );
          }

          return (
            <button
              key={key}
              type="button"
              onClick={() => setLightboxUrl(part.url)}
              className={cn(
                'relative rounded-md overflow-hidden border border-border/50',
                'hover:border-border hover:shadow-sm transition-all cursor-pointer',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
              )}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={part.url}
                alt={part.filename || 'Image attachment'}
                className={cn('object-cover', maxSize)}
                onError={() => setErrorUrls((prev) => new Set(prev).add(part.url))}
              />
            </button>
          );
        })}
      </div>

      {/* Lightbox dialog */}
      <Dialog open={!!lightboxUrl} onOpenChange={(open) => !open && setLightboxUrl(null)}>
        <DialogContent className="max-w-[90vw] max-h-[90vh] p-2">
          <DialogTitle className="sr-only">Image preview</DialogTitle>
          {lightboxUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={lightboxUrl}
              alt="Image preview"
              className="max-w-full max-h-[85vh] object-contain mx-auto"
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
});

ImageMessageContent.displayName = 'ImageMessageContent';
