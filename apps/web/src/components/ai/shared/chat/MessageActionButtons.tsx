import React from 'react';
import { Button } from '@/components/ui/button';
import { Pencil, Trash2, RotateCw, Undo2 } from 'lucide-react';

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
  const buttonSize = 'sm' as const;
  const iconSize = compact ? 'h-2 w-2' : 'h-2.5 w-2.5';

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
