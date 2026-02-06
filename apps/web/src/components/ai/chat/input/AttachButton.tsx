'use client';

import React, { useRef } from 'react';
import { Paperclip } from 'lucide-react';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface AttachButtonProps {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * AttachButton — Paperclip icon that opens a file picker for images.
 * Placed to the left of the textarea in the input row.
 */
export function AttachButton({ onFiles, disabled = false, className }: AttachButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClick = () => {
    inputRef.current?.click();
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (fileList && fileList.length > 0) {
      onFiles(Array.from(fileList));
    }
    // Reset so the same file can be selected again
    e.target.value = '';
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handleClick}
            disabled={disabled}
            className={cn(
              'flex items-center justify-center h-9 w-9 shrink-0 self-end rounded-full',
              'text-muted-foreground hover:text-foreground',
              'transition-colors duration-200',
              'disabled:opacity-40 disabled:cursor-not-allowed',
              className
            )}
            aria-label="Attach images"
          >
            <Paperclip className="h-4 w-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">Attach images</TooltipContent>
      </Tooltip>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/gif,image/webp"
        multiple
        onChange={handleChange}
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
      />
    </>
  );
}
