'use client';

import React, { memo, useState } from 'react';
import { Globe, ExternalLink, Link2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface WebSearchResult {
  title: string;
  url: string;
  snippet?: string;
  description?: string;
  favicon?: string;
  domain?: string;
}

interface WebSearchRendererProps {
  /** Search results */
  results: WebSearchResult[];
  /** The search query */
  query?: string;
  /** Title override */
  title?: string;
  /** Maximum height before scrolling */
  maxHeight?: number;
  /** Additional CSS class */
  className?: string;
}

function extractDomain(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.replace('www.', '');
  } catch {
    return url;
  }
}

// Favicon component with React state for error handling
const FaviconImage: React.FC<{ src: string }> = memo(function FaviconImage({ src }) {
  const [hasError, setHasError] = useState(false);

  if (hasError) {
    return <Link2 className="h-3.5 w-3.5 text-muted-foreground" />;
  }

  return (
    <img
      src={src}
      alt=""
      className="w-4 h-4 rounded"
      onError={() => setHasError(true)}
    />
  );
});

/**
 * WebSearchRenderer - Displays web search results
 *
 * Features:
 * - Clean result cards
 * - Click to open links
 * - Domain display
 * - Snippet preview
 */
export const WebSearchRenderer: React.FC<WebSearchRendererProps> = memo(function WebSearchRenderer({
  results,
  query,
  title = 'Web Search Results',
  maxHeight = 400,
  className
}) {
  const handleOpen = (url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className={cn("rounded-lg border bg-card overflow-hidden my-2 shadow-sm", className)}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-muted/30 border-b">
        <div className="flex items-center gap-2">
          <Globe className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">{title}</span>
        </div>
        <span className="text-xs text-muted-foreground">
          {results.length} {results.length === 1 ? 'result' : 'results'}
        </span>
      </div>

      {/* Query display */}
      {query && (
        <div className="px-3 py-1.5 bg-muted/20 border-b">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Searched for:</span>
            <span className="text-xs font-medium">{query}</span>
          </div>
        </div>
      )}

      {/* Results */}
      <div
        className="bg-background overflow-auto divide-y divide-border"
        style={{ maxHeight: `${maxHeight}px` }}
      >
        {results.length > 0 ? (
          results.map((result, index) => {
            const domain = result.domain || extractDomain(result.url);

            return (
              <button
                key={`${result.url}-${index}`}
                type="button"
                onClick={() => handleOpen(result.url)}
                className="w-full text-left px-3 py-3 hover:bg-muted/50 transition-colors group"
              >
                {/* Domain */}
                <div className="flex items-center gap-1.5 mb-1">
                  {result.favicon ? (
                    <FaviconImage src={result.favicon} />
                  ) : (
                    <Link2 className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                  <span className="text-xs text-muted-foreground truncate">
                    {domain}
                  </span>
                </div>

                {/* Title */}
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-medium text-primary hover:underline truncate flex-1">
                    {result.title}
                  </h3>
                  <ExternalLink className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                </div>

                {/* Snippet */}
                {(result.snippet || result.description) && (
                  <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                    {result.snippet || result.description}
                  </p>
                )}
              </button>
            );
          })
        ) : (
          <div className="text-sm text-muted-foreground text-center py-6">
            <Globe className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p>No results found</p>
          </div>
        )}
      </div>
    </div>
  );
});
