'use client';

import { Switch } from '@/components/ui/switch';
import { EyeIcon, PencilIcon } from 'lucide-react';

interface ReadOnlyToggleProps {
  isReadOnly: boolean;
  onToggle: (value: boolean) => void;
  disabled?: boolean;
  showLabel?: boolean;
  size?: 'sm' | 'default';
}

/**
 * Simple toggle switch for read-only mode
 * Replaces the complex 3-role selector with a single toggle
 */
export function ReadOnlyToggle({
  isReadOnly,
  onToggle,
  disabled = false,
  showLabel = true,
  size = 'default',
}: ReadOnlyToggleProps) {
  const iconSize = size === 'sm' ? 14 : 16;

  return (
    <div className="flex items-center gap-2">
      {isReadOnly ? (
        <EyeIcon size={iconSize} className="text-muted-foreground" />
      ) : (
        <PencilIcon size={iconSize} className="text-muted-foreground" />
      )}
      <Switch
        checked={isReadOnly}
        onCheckedChange={onToggle}
        disabled={disabled}
        className={size === 'sm' ? 'scale-90' : ''}
      />
      {showLabel && (
        <span
          className={`text-muted-foreground ${size === 'sm' ? 'text-xs' : 'text-sm'}`}
        >
          {isReadOnly ? 'Read-only' : 'Read & Write'}
        </span>
      )}
    </div>
  );
}
