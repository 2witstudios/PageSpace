'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ChannelInputRef } from './ChannelInput';

export interface MessageDropZoneProps {
  /** Ref to the ChannelInput composer that owns the attachment slot */
  inputRef: React.RefObject<ChannelInputRef | null>;
  /** Whether dropping is allowed (e.g., user has send permission) */
  enabled: boolean;
  /** Optional className applied to the wrapper div */
  className?: string;
  children: React.ReactNode;
}

const hasFiles = (dataTransfer: DataTransfer | null) => {
  if (!dataTransfer) return false;
  // dataTransfer.types is a DOMStringList in Safari; Array.from normalizes it.
  return Array.from(dataTransfer.types).includes('Files');
};

/**
 * MessageDropZone - wraps a channel/DM view so the entire message pane accepts
 * file drops. On drop, the first file is forwarded to the composer's attachment
 * slot via the imperative `uploadFile` handle.
 */
export function MessageDropZone({
  inputRef,
  enabled,
  className,
  children,
}: MessageDropZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const dragCounter = useRef(0);

  const reset = useCallback(() => {
    dragCounter.current = 0;
    setIsDragging(false);
  }, []);

  // If the drop target gets disabled mid-drag (permission revoked, route change),
  // make sure the overlay doesn't get stuck on.
  useEffect(() => {
    if (!enabled) reset();
  }, [enabled, reset]);

  // Reset the overlay for cases the wrapper's own handlers will not catch:
  // 1. Drop on a child target that calls stopPropagation (e.g. the composer).
  //    Capture phase fires before the target handler can stop propagation.
  // 2. Drag pointer exits the document entirely (no balanced dragleave on the
  //    wrapper). On most browsers this fires a dragleave on document with
  //    relatedTarget === null.
  // 3. Internal drag source completes (dragend bubbles).
  useEffect(() => {
    const handleReset = () => reset();
    const handleDocumentDragLeave = (e: DragEvent) => {
      if (e.relatedTarget === null) reset();
    };
    window.addEventListener('drop', handleReset, true);
    window.addEventListener('dragend', handleReset, true);
    document.addEventListener('dragleave', handleDocumentDragLeave);
    return () => {
      window.removeEventListener('drop', handleReset, true);
      window.removeEventListener('dragend', handleReset, true);
      document.removeEventListener('dragleave', handleDocumentDragLeave);
    };
  }, [reset]);

  const handleDragEnter = (e: React.DragEvent) => {
    if (!enabled || !hasFiles(e.dataTransfer)) return;
    if (!inputRef.current?.canAcceptDrop()) return;
    e.preventDefault();
    dragCounter.current += 1;
    if (dragCounter.current === 1) setIsDragging(true);
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (!enabled || !hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (!enabled || !hasFiles(e.dataTransfer)) return;
    dragCounter.current = Math.max(0, dragCounter.current - 1);
    if (dragCounter.current === 0) setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    if (!enabled || !hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    reset();
    if (!inputRef.current?.canAcceptDrop()) return;
    const file = Array.from(e.dataTransfer?.files ?? [])[0];
    if (file) inputRef.current.uploadFile(file);
  };

  return (
    <div
      className={cn('relative', className)}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      data-testid="message-drop-zone"
    >
      {children}
      {isDragging && (
        <div
          className="pointer-events-none absolute inset-2 z-50 flex items-center justify-center rounded-lg border-2 border-dashed border-primary/60 bg-primary/5 backdrop-blur-[1px]"
          aria-hidden
        >
          <div className="flex flex-col items-center gap-2 text-primary">
            <Upload className="h-8 w-8" />
            <p className="text-sm font-medium">Drop file to attach</p>
          </div>
        </div>
      )}
    </div>
  );
}

export default MessageDropZone;
