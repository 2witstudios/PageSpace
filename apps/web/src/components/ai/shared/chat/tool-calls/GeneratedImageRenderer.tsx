'use client';

import React, { useState } from 'react';
import { cn } from '@/lib/utils';
import { ImageOff } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';

export interface GeneratedImageData {
  viewUrl: string;
  title?: string;
  prompt?: string;
}

/**
 * Renders the result of the generate_image tool: the generated image (served from
 * the durable /api/files/[id]/view route, re-presigned on each load) with a
 * click-to-expand lightbox. Mirrors ImageMessageContent's img + Dialog pattern.
 */
export const GeneratedImageRenderer: React.FC<{ data: GeneratedImageData }> = ({ data }) => {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [hasError, setHasError] = useState(false);
  const alt = data.title || data.prompt || 'Generated image';

  if (hasError) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 p-3 text-sm text-muted-foreground">
        <ImageOff className="h-4 w-4" />
        Generated image is unavailable.
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setLightboxOpen(true)}
        className={cn(
          'relative block rounded-md overflow-hidden border border-border/50 mb-1',
          'hover:border-border hover:shadow-sm transition-all cursor-pointer',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
        )}
        title={data.prompt}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={data.viewUrl}
          alt={alt}
          className="object-cover max-w-[260px] max-h-[260px]"
          onError={() => setHasError(true)}
        />
      </button>

      <Dialog open={lightboxOpen} onOpenChange={setLightboxOpen}>
        <DialogContent className="max-w-[90vw] max-h-[90vh] p-2">
          <DialogTitle className="sr-only">{alt}</DialogTitle>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={data.viewUrl}
            alt={alt}
            className="max-w-full max-h-[85vh] object-contain mx-auto"
          />
        </DialogContent>
      </Dialog>
    </>
  );
};
