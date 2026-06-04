'use client';

import React, { memo } from 'react';
import { Boxes } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface ModelListModel {
  id: string;
  displayName: string;
  provider: string;
  free?: boolean;
  contextWindow?: number;
}

export interface ModelListProvider {
  provider: string;
  name: string;
  dynamic?: boolean;
  models: ModelListModel[];
}

interface ModelListRendererProps {
  providers: ModelListProvider[];
  className?: string;
}

const formatContext = (tokens?: number): string | null => {
  if (!tokens || tokens <= 0) return null;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M ctx`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K ctx`;
  return `${tokens} ctx`;
};

/**
 * ModelListRenderer — compact card for the `list_models` tool result.
 *
 * Groups the catalog by provider, with a free-tier badge and context window per
 * model. Dynamic providers (Ollama/LM Studio/Azure) whose models are discovered
 * at runtime show a note instead of an (empty) model list.
 */
export const ModelListRenderer: React.FC<ModelListRendererProps> = memo(function ModelListRenderer({
  providers,
  className,
}) {
  const totalModels = providers.reduce((sum, p) => sum + p.models.length, 0);

  return (
    <div className={cn('rounded-md border border-border bg-muted/30 text-sm', className)}>
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 font-medium">
        <Boxes className="h-4 w-4 text-muted-foreground" />
        <span>Available models</span>
        <span className="text-muted-foreground">
          · {providers.length} provider{providers.length === 1 ? '' : 's'} · {totalModels} model
          {totalModels === 1 ? '' : 's'}
        </span>
      </div>
      <div className="max-h-80 space-y-3 overflow-y-auto p-3">
        {providers.map((provider) => (
          <div key={provider.provider}>
            <div className="mb-1 text-xs font-semibold text-muted-foreground">{provider.name}</div>
            {provider.dynamic && provider.models.length === 0 ? (
              <div className="text-xs text-muted-foreground/80">Models discovered at runtime.</div>
            ) : (
              <ul className="space-y-0.5">
                {provider.models.map((model) => {
                  const ctx = formatContext(model.contextWindow);
                  return (
                    <li key={model.id} className="flex items-center gap-2">
                      <span className="truncate">{model.displayName}</span>
                      <code className="truncate text-xs text-muted-foreground">{model.id}</code>
                      {model.free && (
                        <span className="rounded bg-emerald-500/15 px-1 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                          free
                        </span>
                      )}
                      {ctx && <span className="ml-auto text-[10px] text-muted-foreground">{ctx}</span>}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ))}
      </div>
    </div>
  );
});
