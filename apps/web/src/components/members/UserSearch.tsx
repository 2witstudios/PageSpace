'use client';

import { useState, useEffect } from 'react';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Search, User } from 'lucide-react';
import { useDebounce } from '@/hooks/use-debounce';

interface SearchResult {
  userId: string;
  username?: string;
  displayName: string;
  email: string;
  bio?: string;
  avatarUrl?: string;
}

interface UserSearchProps {
  onSelect: (user: SearchResult) => void;
}

export function UserSearch({ onSelect }: UserSearchProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const debouncedQuery = useDebounce(query, 300);

  useEffect(() => {
    if (debouncedQuery.length < 2) {
      setResults([]);
      return;
    }

    const searchUsers = async () => {
      setLoading(true);
      try {
        const response = await fetch(`/api/users/search?q=${encodeURIComponent(debouncedQuery)}`, {
          credentials: 'include',
        });
        if (!response.ok) throw new Error('Search failed');
        const data = await response.json();
        setResults(data.users || []);
      } catch (error) {
        console.error('Error searching users:', error);
        setResults([]);
      } finally {
        setLoading(false);
      }
    };

    searchUsers();
  }, [debouncedQuery]);

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map(n => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  return (
    <div className="space-y-4">
      {/* Search Input */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
        <Input
          type="text"
          placeholder="Search by username, name, or email..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-10"
          autoFocus
        />
      </div>

      {/* Help Text */}
      {query.length === 0 && (
        <p className="text-sm text-gray-600">
          Enter a username, display name, or email address to find users
        </p>
      )}

      {/* Loading State */}
      {loading && (
        <div className="flex justify-center py-4">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-gray-900" />
        </div>
      )}

      {/* Results */}
      {!loading && results.length > 0 && (
        <div className="space-y-2 max-h-96 overflow-y-auto">
          {results.map((user) => (
            <button
              key={user.userId}
              onClick={() => onSelect(user)}
              className="w-full p-3 rounded-lg border hover:bg-gray-50 transition-colors flex items-center space-x-3 text-left"
            >
              <Avatar>
                <AvatarImage src={user.avatarUrl} alt={user.displayName} />
                <AvatarFallback>
                  {user.displayName ? getInitials(user.displayName) : <User className="w-4 h-4" />}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1">
                <div className="flex items-center space-x-2">
                  <p className="font-medium">{user.displayName}</p>
                  {user.username && (
                    <span className="text-sm text-gray-500">@{user.username}</span>
                  )}
                </div>
                <p className="text-sm text-gray-600">{user.email}</p>
                {user.bio && (
                  <p className="text-xs text-gray-500 mt-1 line-clamp-1">{user.bio}</p>
                )}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* No Results */}
      {!loading && query.length >= 2 && results.length === 0 && (
        <div className="text-center py-8 text-gray-500">
          <User className="w-12 h-12 mx-auto mb-2 opacity-50" />
          <p>No users found</p>
          <p className="text-sm mt-1">Try searching by email address</p>
        </div>
      )}
    </div>
  );
}