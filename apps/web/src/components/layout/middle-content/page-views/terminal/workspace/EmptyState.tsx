import type { ReactNode } from 'react';

interface EmptyStateProps {
  title: string;
  description?: string;
  children?: ReactNode;
}

export default function EmptyState({ title, description, children }: EmptyStateProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <p className="text-sm font-medium text-muted-foreground">{title}</p>
      {description && <p className="max-w-xs text-xs text-muted-foreground/70">{description}</p>}
      {children}
    </div>
  );
}
