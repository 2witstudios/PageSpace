'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { FileText, FolderOpen, Hash, MessageSquare, HardDrive, User, Sparkles, Table } from 'lucide-react';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { useDebouncedCallback } from 'use-debounce';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

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

interface GlobalSearchProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
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

export default function GlobalSearch({ open, onOpenChange }: GlobalSearchProps) {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);

  const performSearch = useDebouncedCallback(async (query: string) => {
    if (query.length < 2) {
      setResults([]);
      return;
    }

    setLoading(true);
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

  const handleSelect = useCallback((result: SearchResult) => {
    onOpenChange(false);
    setSearch('');
    setResults([]);

    // Navigate based on result type
    switch (result.type) {
      case 'drive':
        // Navigate to drive dashboard
        router.push(`/dashboard/${result.id}`);
        break;
      case 'page':
        // Navigate to page within drive
        if (result.driveId) {
          router.push(`/dashboard/${result.driveId}/${result.id}`);
        }
        break;
      case 'user':
        // For now, just close the dialog (could navigate to user profile in future)
        break;
    }
  }, [router, onOpenChange]);

  // Group results by type
  const driveResults = results.filter(r => r.type === 'drive');
  const pageResults = results.filter(r => r.type === 'page');
  const userResults = results.filter(r => r.type === 'user');

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Global Search"
      description="Search for pages, drives, and users"
    >
      <CommandInput
        placeholder="Search pages, drives, and users..."
        value={search}
        onValueChange={setSearch}
      />
      <CommandList>
        {loading && (
          <div className="py-6 text-center text-sm text-muted-foreground">
            Searching...
          </div>
        )}

        {!loading && search.length >= 2 && results.length === 0 && (
          <CommandEmpty>No results found.</CommandEmpty>
        )}

        {!loading && search.length < 2 && (
          <div className="py-6 text-center text-sm text-muted-foreground">
            Type at least 2 characters to search
          </div>
        )}

        {driveResults.length > 0 && (
          <CommandGroup heading="Drives">
            {driveResults.map((result) => (
              <CommandItem
                key={result.id}
                value={result.title}
                onSelect={() => handleSelect(result)}
                className="flex items-center gap-2"
              >
                <HardDrive className="h-4 w-4 text-muted-foreground" />
                <div className="flex-1">
                  <div className="font-medium">{result.title}</div>
                  {result.description && (
                    <div className="text-sm text-muted-foreground">
                      {result.description}
                    </div>
                  )}
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {pageResults.length > 0 && (
          <CommandGroup heading="Pages">
            {pageResults.map((result) => (
              <CommandItem
                key={result.id}
                value={result.title}
                onSelect={() => handleSelect(result)}
                className="flex items-center gap-2"
              >
                <span className="text-muted-foreground">
                  {getPageIcon(result.pageType)}
                </span>
                <div className="flex-1">
                  <div className="font-medium">{result.title}</div>
                  {result.description && (
                    <div className="text-sm text-muted-foreground">
                      {result.description}
                    </div>
                  )}
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {userResults.length > 0 && (
          <CommandGroup heading="Users">
            {userResults.map((result) => (
              <CommandItem
                key={result.id}
                value={result.title}
                onSelect={() => handleSelect(result)}
                className="flex items-center gap-2"
              >
                <User className="h-4 w-4 text-muted-foreground" />
                <div className="flex-1">
                  <div className="font-medium">{result.title}</div>
                  {result.description && (
                    <div className="text-sm text-muted-foreground">
                      {result.description}
                    </div>
                  )}
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}