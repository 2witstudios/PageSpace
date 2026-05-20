'use client';

import { MessageSquareReply } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ThreadOriginBadgeProps {
  onOpenThread?: () => void;
  className?: string;
}

export function ThreadOriginBadge({ onOpenThread, className }: ThreadOriginBadgeProps) {
  const base = cn(
    'border-l-2 border-muted pl-3 py-0.5 mb-1 text-xs text-muted-foreground flex items-center gap-1.5',
    className,
  );

  if (onOpenThread) {
    return (
      <button
        type="button"
        onClick={onOpenThread}
        className={cn(base, 'hover:text-foreground hover:border-primary/60 transition-colors')}
      >
        <MessageSquareReply size={11} />
        Also sent from thread
      </button>
    );
  }

  return (
    <div className={base}>
      <MessageSquareReply size={11} />
      Also sent from thread
    </div>
  );
}
