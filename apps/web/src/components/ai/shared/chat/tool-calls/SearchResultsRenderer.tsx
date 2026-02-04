'use client';

import React, { memo } from 'react';
import { usePageNavigation } from '@/hooks/usePageNavigation';
import { Search, ExternalLink, FileText, Hash } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PageTypeIcon } from '@/components/common/PageTypeIcon';
import { PageType } from '@pagespace/lib/client-safe';

interface SearchMatch {
  lineNumber?: number;
  content?: string;
  context?: string;
}

export interface SearchResult {
  pageId: string;
  title: string;
  type?: string;
  driveId?: string;
  driveName?: string;
  path?: string;
  matches?: SearchMatch[];
  matchCount?: number;
}

interface SearchResultsRendererProps {
  /** Search results */
  results: SearchResult[];
  /** The search query/pattern used */
  query?: string;
  /** Search type (regex, glob, multi-drive) */
  searchType?: 'regex' | 'glob' | 'multi-drive';
  /** Total match count */
  totalMatches?: number;
  /** Title override */
  title?: string;
  /** Maximum height before scrolling */
  maxHeight?: number;
  /** Additional CSS class */
  className?: string;
}

/**
 * SearchResultsRenderer - Displays search results in a clean format
 *
 * Features:
 * - Click to navigate to matching pages
 * - Shows match context/snippets
 * - Groups by drive for multi-drive search
 * - Match count indicators
 */
export const SearchResultsRenderer: React.FC<SearchResultsRendererProps> = memo(function SearchResultsRenderer({
  results,
  query,
  searchType = 'regex',
  totalMatches,
  title,
  maxHeight = 350,
  className
}) {
  const { navigateToPage } = usePageNavigation();

  const displayTitle = title || (
    searchType === 'multi-drive' ? 'Search Results (All Workspaces)' :
    searchType === 'glob' ? 'Matching Pages' :
    'Search Results'
  );

  const resultCount = results.length;
  const matchInfo = totalMatches !== undefined
    ? `${totalMatches} matches in ${resultCount} ${resultCount === 1 ? 'page' : 'pages'}`
    : `${resultCount} ${resultCount === 1 ? 'result' : 'results'}`;

  return (
    <div className={cn("rounded-lg border bg-card overflow-hidden my-2 shadow-sm", className)}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-muted/30 border-b">
        <div className="flex items-center gap-2">
          <Search className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">{displayTitle}</span>
        </div>
        <span className="text-xs text-muted-foreground">{matchInfo}</span>
      </div>

      {/* Query display */}
      {query && (
        <div className="px-3 py-1.5 bg-muted/20 border-b">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {searchType === 'glob' ? 'Pattern:' : 'Query:'}
            </span>
            <code className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded">
              {query}
            </code>
          </div>
        </div>
      )}

      {/* Results */}
      <div
        className="bg-background overflow-auto divide-y divide-border"
        style={{ maxHeight: `${maxHeight}px` }}
      >
        {results.length > 0 ? (
          results.map((result, index) => (
            <button
              key={`${result.pageId}-${index}`}
              type="button"
              onClick={() => navigateToPage(result.pageId, result.driveId)}
              className="w-full text-left px-3 py-2 hover:bg-muted/50 transition-colors group"
            >
              {/* Page header */}
              <div className="flex items-center gap-2">
                <PageTypeIcon
                  type={(result.type || 'DOCUMENT') as PageType}
                  className="h-4 w-4 text-muted-foreground shrink-0"
                />
                <span className="text-sm font-medium truncate flex-1">
                  {result.title}
                </span>
                {result.matchCount !== undefined && result.matchCount > 0 && (
                  <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                    {result.matchCount} {result.matchCount === 1 ? 'match' : 'matches'}
                  </span>
                )}
                <ExternalLink className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
              </div>

              {/* Drive name for multi-drive search */}
              {result.driveName && (
                <div className="text-xs text-muted-foreground mt-0.5 ml-6">
                  in {result.driveName}
                </div>
              )}

              {/* Path display */}
              {result.path && (
                <div className="text-xs text-muted-foreground mt-0.5 ml-6 truncate">
                  {result.path}
                </div>
              )}

              {/* Match snippets */}
              {result.matches && result.matches.length > 0 && (
                <div className="mt-1.5 ml-6 space-y-1">
                  {result.matches.slice(0, 3).map((match, matchIndex) => (
                    <div
                      key={matchIndex}
                      className="flex items-start gap-2 text-xs"
                    >
                      {match.lineNumber !== undefined && (
                        <span className="flex items-center gap-0.5 text-muted-foreground shrink-0">
                          <Hash className="h-3 w-3" />
                          {match.lineNumber}
                        </span>
                      )}
                      <span className="text-muted-foreground truncate">
                        {match.content || match.context}
                      </span>
                    </div>
                  ))}
                  {result.matches.length > 3 && (
                    <div className="text-xs text-muted-foreground">
                      +{result.matches.length - 3} more matches
                    </div>
                  )}
                </div>
              )}
            </button>
          ))
        ) : (
          <div className="text-sm text-muted-foreground text-center py-6">
            <FileText className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p>No results found</p>
          </div>
        )}
      </div>
    </div>
  );
});
