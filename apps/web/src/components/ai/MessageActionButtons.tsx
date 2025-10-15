import React from 'react';
import { Button } from '@/components/ui/button';
import { Pencil, Trash2, RotateCw } from 'lucide-react';

interface MessageActionButtonsProps {
  onEdit: () => void;
  onDelete: () => void;
  onRetry?: () => void; // Only available for last assistant message
  disabled?: boolean;
  compact?: boolean; // For sidebar compact view
}

export const MessageActionButtons: React.FC<MessageActionButtonsProps> = ({
  onEdit,
  onDelete,
  onRetry,
  disabled = false,
  compact = false,
}) => {
  const buttonSize = compact ? 'sm' : 'sm';
  const iconSize = compact ? 'h-3 w-3' : 'h-3.5 w-3.5';

  return (
    <div className={`flex items-center space-x-1 ${compact ? 'opacity-0 group-hover:opacity-100' : 'opacity-0 group-hover:opacity-100'} transition-opacity`}>
      {onRetry && (
        <Button
          variant="ghost"
          size={buttonSize}
          onClick={onRetry}
          disabled={disabled}
          className="h-7 px-2"
          title="Retry this message"
        >
          <RotateCw className={iconSize} />
        </Button>
      )}
      <Button
        variant="ghost"
        size={buttonSize}
        onClick={onEdit}
        disabled={disabled}
        className="h-7 px-2"
        title="Edit message"
      >
        <Pencil className={iconSize} />
      </Button>
      <Button
        variant="ghost"
        size={buttonSize}
        onClick={onDelete}
        disabled={disabled}
        className="h-7 px-2 hover:bg-destructive/10 hover:text-destructive"
        title="Delete message"
      >
        <Trash2 className={iconSize} />
      </Button>
    </div>
  );
};
