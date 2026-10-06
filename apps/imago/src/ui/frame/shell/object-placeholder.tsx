import type { ReactNode } from 'react';

/**
 * What a stage route puts in the object slot until its section's leaf
 * renders the real object (documents, channels, task lists, settings).
 */
export function renderObjectPlaceholder(label: string): ReactNode {
  return (
    <div className="p-4 text-ink-muted" data-object-placeholder="">
      {label}
    </div>
  );
}
