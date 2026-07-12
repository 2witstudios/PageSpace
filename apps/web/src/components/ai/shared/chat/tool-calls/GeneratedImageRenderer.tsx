'use client';

import React, { useState } from 'react';
import { cn } from '@/lib/utils';
import { ImageOff, Loader2 } from 'lucide-react';
import { usePageNavigation } from '@/hooks/usePageNavigation';

export interface GeneratedImageToolPart {
  state?: 'input-streaming' | 'input-available' | 'output-available' | 'output-error' | 'done' | 'streaming';
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

interface GeneratedImageOutput {
  success?: boolean;
  error?: string;
  viewUrl?: string;
  title?: string;
  prompt?: string;
  pageId?: string;
  driveId?: string;
}

const safeJsonParse = (value: unknown): Record<string, unknown> | null => {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value === 'object' && value !== null) {
    return value as Record<string, unknown>;
  }
  return null;
};

const BOX_SIZE = 'w-[260px] h-[260px] max-w-[260px] max-h-[260px]';

/**
 * Renders a generate_image tool call inline — no accordion, always visible.
 * Owns all three tool-call states (loading/error/success) since it fully
 * bypasses the generic accordion shell (see tool-call-dispatch.ts's 'image'
 * kind). Clicking the finished image navigates to where it's saved in the
 * user's Home drive (usePageNavigation), rather than opening a lightbox.
 */
export const GeneratedImageRenderer: React.FC<{ part: GeneratedImageToolPart }> = ({ part }) => {
  const { navigateToPage } = usePageNavigation();
  const [loadError, setLoadError] = useState(false);

  const parsedInput = safeJsonParse(part.input);
  const parsedOutput = safeJsonParse(part.output) as GeneratedImageOutput | null;
  const state = part.state ?? 'input-available';

  const failed = state === 'output-error' || parsedOutput?.success === false || loadError;
  const isLoading = !failed && !parsedOutput?.viewUrl;

  if (isLoading) {
    return (
      <div className={cn(BOX_SIZE, 'flex items-center justify-center rounded-md border border-border/50 bg-muted/50 my-2 animate-pulse')}>
        <Loader2 className="h-5 w-5 text-muted-foreground animate-spin" />
      </div>
    );
  }

  if (failed) {
    const message = part.errorText || parsedOutput?.error || 'Generated image is unavailable.';
    return (
      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 p-3 text-sm text-muted-foreground my-2">
        <ImageOff className="h-4 w-4 shrink-0" />
        {message}
      </div>
    );
  }

  const viewUrl = parsedOutput!.viewUrl!;
  const prompt = parsedOutput?.prompt ?? (parsedInput?.prompt as string | undefined);
  const alt = parsedOutput?.title || prompt || 'Generated image';
  const pageId = parsedOutput?.pageId;

  return (
    <button
      type="button"
      onClick={() => pageId && navigateToPage(pageId, parsedOutput?.driveId)}
      disabled={!pageId}
      className={cn(
        'relative block rounded-md overflow-hidden border border-border/50 my-2',
        pageId && 'hover:border-border hover:shadow-sm transition-all cursor-pointer',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
      )}
      title={pageId ? 'Open in your drive' : prompt}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={viewUrl}
        alt={alt}
        className="object-cover max-w-[260px] max-h-[260px]"
        onError={() => setLoadError(true)}
      />
    </button>
  );
};
