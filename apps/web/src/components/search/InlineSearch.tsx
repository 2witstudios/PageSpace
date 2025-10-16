'use client';

import { useState, useEffect, useCallback, useRef, KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Search, X, FileText, FolderOpen, Hash, MessageSquare, HardDrive, User, Sparkles, Loader2, Table } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useDebouncedCallback } from 'use-debounce';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '@/lib/auth-fetch';

interface SearchResult {
  id: string;
  title: string;
  type: 'page' | 'drive' | 'user';
  pageType?: string;
  driveId?: string;
  driveName?: string;
  description?: string;
  avatarUrl?: string | null;
}

const getPageIcon = (pageType?: string) => {
  switch (pageType) {
    case 'DOCUMENT':
      return <FileText className="h-4 w-4" />;
    case 'FOLDER':
      return <FolderOpen className="h-4 w-4" />;
    case 'CHANNEL':
      return <Hash className="h-4 w-4" />;
    case 'AI_CHAT':
      return <MessageSquare className="h-4 w-4" />;
    case 'CANVAS':
      return <Sparkles className="h-4 w-4" />;
    case 'SHEET':
      return <Table className="h-4 w-4" />;
    default:
      return <FileText className="h-4 w-4" />;
  }
};

export default function InlineSearch() {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const performSearch = useDebouncedCallback(async (query: string) => {
    if (query.length < 2) {
      setResults([]);
      setIsOpen(false);
      return;
    }

    setLoading(true);
    setIsOpen(true);
    try {
      const response = await fetchWithAuth(`/api/search?q=${encodeURIComponent(query)}`);
      if (response.ok) {
        const data = await response.json();
        setResults(data.results || []);
      }
    } catch (error) {
      console.error('Search error:', error);
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, 300);

  useEffect(() => {
    performSearch(search);
  }, [search, performSearch]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
        setSelectedIndex(-1);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Keyboard shortcut to focus search
  useEffect(() => {
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      // Cmd+K (Mac) or Ctrl+K (Windows/Linux)
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        setIsOpen(true);
      }
      // Escape to close
      if (e.key === 'Escape' && isOpen) {
        setIsOpen(false);
        setSelectedIndex(-1);
        inputRef.current?.blur();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  const handleSelect = useCallback((result: SearchResult) => {
    setSearch('');
    setResults([]);
    setIsOpen(false);
    setSelectedIndex(-1);

    // Navigate based on result type
    switch (result.type) {
      case 'drive':
        router.push(`/dashboard?driveId=${result.id}`);
        break;
      case 'page':
        if (result.driveId) {
          router.push(`/dashboard?driveId=${result.driveId}&pageId=${result.id}`);
        }
        break;
      case 'user':
        // For now, just close (could navigate to user profile in future)
        break;
    }
  }, [router]);

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(prev =>
        prev < results.length - 1 ? prev + 1 : 0
      );
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(prev =>
        prev > 0 ? prev - 1 : results.length - 1
      );
    } else if (e.key === 'Enter' && selectedIndex >= 0 && selectedIndex < results.length) {
      e.preventDefault();
      handleSelect(results[selectedIndex]);
    }
  };

  const clearSearch = () => {
    setSearch('');
    setResults([]);
    setIsOpen(false);
    setSelectedIndex(-1);
    inputRef.current?.focus();
  };

  // Group results by type
  const driveResults = results.filter(r => r.type === 'drive');
  const pageResults = results.filter(r => r.type === 'page');
  const userResults = results.filter(r => r.type === 'user');

  return (
    <div className="relative w-96">
      <div className="relative">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
        <Input
          ref={inputRef}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => search.length >= 2 && setIsOpen(true)}
          placeholder="Search... (⌘K)"
          className="pl-8 pr-8"
        />
        {search && (
          <Button
            variant="ghost"
            size="icon"
            onClick={clearSearch}
            className="absolute right-0 top-0 h-full px-2 hover:bg-transparent"
          >
            <X className="h-4 w-4 text-muted-foreground" />
          </Button>
        )}
      </div>

      {/* Search Results Dropdown */}
      {isOpen && (
        <div
          ref={dropdownRef}
          className="absolute top-full mt-1 w-full bg-popover border rounded-md shadow-md max-h-96 overflow-auto z-50"
        >
          {loading && (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              <span className="ml-2 text-sm text-muted-foreground">Searching...</span>
            </div>
          )}

          {!loading && search.length >= 2 && results.length === 0 && (
            <div className="py-6 text-center text-sm text-muted-foreground">
              No results found
            </div>
          )}

          {!loading && search.length < 2 && (
            <div className="py-6 text-center text-sm text-muted-foreground">
              Type to search...
            </div>
          )}

          {!loading && results.length > 0 && (
            <div className="py-2">
              {driveResults.length > 0 && (
                <div className="mb-2">
                  <div className="px-3 py-1 text-xs font-semibold text-muted-foreground">
                    Drives
                  </div>
                  {driveResults.map((result, idx) => (
                    <button
                      key={result.id}
                      onClick={() => handleSelect(result)}
                      onMouseEnter={() => setSelectedIndex(idx)}
                      className={cn(
                        "w-full px-3 py-2 flex items-center gap-2 hover:bg-accent text-left",
                        selectedIndex === idx && "bg-accent"
                      )}
                    >
                      <HardDrive className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                      <div className="flex-1 overflow-hidden">
                        <div className="font-medium truncate">{result.title}</div>
                        {result.description && (
                          <div className="text-sm text-muted-foreground truncate">
                            {result.description}
                          </div>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {pageResults.length > 0 && (
                <div className="mb-2">
                  <div className="px-3 py-1 text-xs font-semibold text-muted-foreground">
                    Pages
                  </div>
                  {pageResults.map((result, idx) => {
                    const actualIndex = driveResults.length + idx;
                    return (
                      <button
                        key={result.id}
                        onClick={() => handleSelect(result)}
                        onMouseEnter={() => setSelectedIndex(actualIndex)}
                        className={cn(
                          "w-full px-3 py-2 flex items-center gap-2 hover:bg-accent text-left",
                          selectedIndex === actualIndex && "bg-accent"
                        )}
                      >
                        <span className="text-muted-foreground flex-shrink-0">
                          {getPageIcon(result.pageType)}
                        </span>
                        <div className="flex-1 overflow-hidden">
                          <div className="font-medium truncate">{result.title}</div>
                          {result.description && (
                            <div className="text-sm text-muted-foreground truncate">
                              {result.description}
                            </div>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}

              {userResults.length > 0 && (
                <div>
                  <div className="px-3 py-1 text-xs font-semibold text-muted-foreground">
                    Users
                  </div>
                  {userResults.map((result, idx) => {
                    const actualIndex = driveResults.length + pageResults.length + idx;
                    return (
                      <button
                        key={result.id}
                        onClick={() => handleSelect(result)}
                        onMouseEnter={() => setSelectedIndex(actualIndex)}
                        className={cn(
                          "w-full px-3 py-2 flex items-center gap-2 hover:bg-accent text-left",
                          selectedIndex === actualIndex && "bg-accent"
                        )}
                      >
                        <User className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                        <div className="flex-1 overflow-hidden">
                          <div className="font-medium truncate">{result.title}</div>
                          {result.description && (
                            <div className="text-sm text-muted-foreground truncate">
                              {result.description}
                            </div>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}