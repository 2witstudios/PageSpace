'use client';

import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Pencil, Trash2, RotateCw, Undo2, MoreHorizontal } from 'lucide-react';
import { useMobile } from '@/hooks/useMobile';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';

interface MessageActionButtonsProps {
  onEdit: () => void;
  onDelete: () => void;
  onRetry?: () => void; // Only available for last assistant message
  onUndoFromHere?: () => void; // Undo from this message forward (AI messages with tool calls)
  disabled?: boolean;
  compact?: boolean; // For sidebar compact view
}

export const MessageActionButtons: React.FC<MessageActionButtonsProps> = ({
  onEdit,
  onDelete,
  onRetry,
  onUndoFromHere,
  disabled = false,
  compact = false,
}) => {
  const isMobile = useMobile();
  const [sheetOpen, setSheetOpen] = useState(false);
  const buttonSize = 'sm' as const;
  const iconSize = compact ? 'h-2 w-2' : 'h-2.5 w-2.5';

  // Mobile: single tap button that opens action sheet
  if (isMobile) {
    return (
      <>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setSheetOpen(true)}
          disabled={disabled}
          className="h-6 w-6 p-0"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </Button>

        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetContent
            side="bottom"
            className="rounded-t-2xl pb-[calc(1rem+env(safe-area-inset-bottom))]"
          >
            <SheetHeader className="px-5 pt-3 pb-0">
              <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-muted-foreground/30" />
              <SheetTitle className="text-base">Message</SheetTitle>
              <SheetDescription className="sr-only">Message actions</SheetDescription>
            </SheetHeader>

            <div className="px-5 pb-4 mt-2 space-y-1">
              {onRetry && (
                <button
                  onClick={() => { setSheetOpen(false); onRetry(); }}
                  disabled={disabled}
                  className="flex items-center gap-3 w-full px-3 py-3 rounded-lg text-sm active:bg-accent transition-colors disabled:opacity-50"
                >
                  <RotateCw className="h-5 w-5 text-muted-foreground" />
                  <span className="font-medium">Retry</span>
                </button>
              )}
              {onUndoFromHere && (
                <button
                  onClick={() => { setSheetOpen(false); onUndoFromHere(); }}
                  disabled={disabled}
                  className="flex items-center gap-3 w-full px-3 py-3 rounded-lg text-sm active:bg-accent transition-colors disabled:opacity-50"
                >
                  <Undo2 className="h-5 w-5 text-muted-foreground" />
                  <span className="font-medium">Undo from here</span>
                </button>
              )}
              <button
                onClick={() => { setSheetOpen(false); onEdit(); }}
                disabled={disabled}
                className="flex items-center gap-3 w-full px-3 py-3 rounded-lg text-sm active:bg-accent transition-colors disabled:opacity-50"
              >
                <Pencil className="h-5 w-5 text-muted-foreground" />
                <span className="font-medium">Edit</span>
              </button>
              <div className="h-px bg-border my-2" />
              <button
                onClick={() => { setSheetOpen(false); onDelete(); }}
                disabled={disabled}
                className="flex items-center gap-3 w-full px-3 py-3 rounded-lg text-sm text-destructive active:bg-destructive/10 transition-colors disabled:opacity-50"
              >
                <Trash2 className="h-5 w-5" />
                <span className="font-medium">Delete</span>
              </button>
            </div>
          </SheetContent>
        </Sheet>
      </>
    );
  }

  // Desktop: hover-to-reveal row of buttons
  return (
    <div className="flex items-center space-x-1 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
      {onRetry && (
        <Button
          variant="ghost"
          size={buttonSize}
          onClick={onRetry}
          disabled={disabled}
          className="h-5 px-1"
          title="Retry this message"
        >
          <RotateCw className={iconSize} />
        </Button>
      )}
      {onUndoFromHere && (
        <Button
          variant="ghost"
          size={buttonSize}
          onClick={onUndoFromHere}
          disabled={disabled}
          className="h-5 px-1"
          title="Undo from here"
        >
          <Undo2 className={iconSize} />
        </Button>
      )}
      <Button
        variant="ghost"
        size={buttonSize}
        onClick={onEdit}
        disabled={disabled}
        className="h-5 px-1"
        title="Edit message"
      >
        <Pencil className={iconSize} />
      </Button>
      <Button
        variant="ghost"
        size={buttonSize}
        onClick={onDelete}
        disabled={disabled}
        className="h-5 px-1 hover:bg-destructive/10 hover:text-destructive"
        title="Delete message"
      >
        <Trash2 className={iconSize} />
      </Button>
    </div>
  );
};
