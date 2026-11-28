'use client';

import { ChevronLeft, ChevronRight, Minus, Plus } from 'lucide-react';
import { Button } from '@/retained/components/ui/button';

export const MIN_SCALE = 0.5;
export const MAX_SCALE = 3;
export const SCALE_STEP = 0.25;

export const clampScale = (scale: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

export interface PdfControlsProps {
  readonly pageNumber: number;
  readonly numPages: number | null;
  readonly scale: number;
  readonly onPageChange: (pageNumber: number) => void;
  readonly onScaleChange: (scale: number) => void;
}

/** The PDF viewer bar: labelled page stepping as "n / N", and zoom with its percentage. */
export function PdfControls({ pageNumber, numPages, scale, onPageChange, onScaleChange }: PdfControlsProps) {
  const lastPage = numPages || 1;
  return (
    <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs text-muted-foreground">
      <Button
        variant="ghost"
        size="sm"
        aria-label="Previous page"
        onClick={() => onPageChange(pageNumber - 1)}
        disabled={pageNumber <= 1}
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <span className="font-mono tabular-nums">
        {pageNumber} / {numPages ?? '…'}
      </span>
      <Button
        variant="ghost"
        size="sm"
        aria-label="Next page"
        onClick={() => onPageChange(pageNumber + 1)}
        disabled={pageNumber >= lastPage}
      >
        <ChevronRight className="h-4 w-4" />
      </Button>
      <div className="flex-1" />
      <Button
        variant="ghost"
        size="sm"
        aria-label="Zoom out"
        onClick={() => onScaleChange(clampScale(scale - SCALE_STEP))}
        disabled={scale <= MIN_SCALE}
      >
        <Minus className="h-4 w-4" />
      </Button>
      <span className="w-12 text-center font-mono tabular-nums">{Math.round(scale * 100)}%</span>
      <Button
        variant="ghost"
        size="sm"
        aria-label="Zoom in"
        onClick={() => onScaleChange(clampScale(scale + SCALE_STEP))}
        disabled={scale >= MAX_SCALE}
      >
        <Plus className="h-4 w-4" />
      </Button>
    </div>
  );
}
