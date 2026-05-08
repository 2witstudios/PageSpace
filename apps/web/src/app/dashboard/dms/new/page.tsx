'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Search, ArrowLeft, UserPlus } from 'lucide-react';
import useSWR from 'swr';
import { toast } from 'sonner';
import { post, fetchWithAuth } from '@/lib/auth/auth-fetch';

const fetcher = async (url: string) => {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status}`);
  }
  return response.json();
};

interface MessageableUser {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
  username: string | null;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  source: 'connection' | 'drive';
  sharedDriveCount: number;
}

export default function NewConversationPage() {
  const router = useRouter();
  const { } = useAuth();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const { data: messageableData } = useSWR<{ users: MessageableUser[] }>(
    '/api/users/messageable',
    fetcher
  );

  const filteredUsers = messageableData?.users?.filter((u) => {
    const displayName = u.displayName || u.name || '';
    const username = u.username || '';
    return (
      displayName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      username.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }) || [];

  const handleStartConversation = async () => {
    if (!selectedUserId) {
      toast.error('Please select a user to message');
      return;
    }

    setIsCreating(true);

    try {
      const { conversation } = await post<{ conversation: { id: string } }>('/api/messages/conversations', {
        recipientId: selectedUserId,
      });

      router.push(`/dashboard/dms/${conversation.id}`);
    } catch (error) {
      toast.error((error as Error).message || 'Failed to start conversation');
      setIsCreating(false);
    }
  };

  const handleConnectionsClick = () => {
    router.push('/dashboard/connections');
  };

  return (
    <div className="flex-1 flex flex-col">
      <div className="border-b border-border p-4">
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => router.push('/dashboard/dms')}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h2 className="text-lg font-semibold">New Conversation</h2>
        </div>
      </div>

      <div className="flex-1 p-6">
        <div className="max-w-2xl mx-auto">
          <div className="mb-6">
            <Label htmlFor="search" className="mb-2 block">
              Select someone to message
            </Label>
            <div className="relative">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                id="search"
                placeholder="Search connections and drive members..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>
          </div>

          <ScrollArea className="h-[400px] border rounded-lg">
            <div className="p-4">
              {filteredUsers.length === 0 && !searchQuery && (
                <div className="text-center py-8">
                  <UserPlus className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                  <p className="text-muted-foreground mb-4">
                    Connect with someone or join a shared drive to start messaging
                  </p>
                  <Button onClick={handleConnectionsClick} variant="outline">
                    Manage Connections
                  </Button>
                </div>
              )}

              {filteredUsers.length === 0 && searchQuery && (
                <div className="text-center py-8">
                  <p className="text-muted-foreground">
                    No matches for &quot;{searchQuery}&quot;
                  </p>
                </div>
              )}

              {filteredUsers.map((u) => {
                const displayName = u.displayName || u.name || u.email;
                const isSelected = selectedUserId === u.id;
                const sourceLabel =
                  u.source === 'connection'
                    ? 'Connection'
                    : u.sharedDriveCount > 1
                      ? `Shares ${u.sharedDriveCount} drives`
                      : 'Shared drive';

                return (
                  <div
                    key={u.id}
                    onClick={() => setSelectedUserId(u.id)}
                    className={`flex items-center gap-3 p-3 rounded-lg cursor-pointer transition-colors ${
                      isSelected
                        ? 'bg-accent border-2 border-primary'
                        : 'hover:bg-accent border-2 border-transparent'
                    }`}
                  >
                    <Avatar className="h-10 w-10">
                      <AvatarImage src={u.image || u.avatarUrl || ''} />
                      <AvatarFallback>
                        {displayName.charAt(0).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-medium truncate">{displayName}</p>
                        <span className="text-xs text-muted-foreground shrink-0">
                          · {sourceLabel}
                        </span>
                      </div>
                      {u.username && (
                        <p className="text-sm text-muted-foreground truncate">
                          @{u.username}
                        </p>
                      )}
                      {u.bio && (
                        <p className="text-sm text-muted-foreground line-clamp-1">
                          {u.bio}
                        </p>
                      )}
                    </div>

                    {isSelected && (
                      <div className="text-primary">
                        <svg
                          className="h-5 w-5"
                          fill="currentColor"
                          viewBox="0 0 20 20"
                        >
                          <path
                            fillRule="evenodd"
                            d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                            clipRule="evenodd"
                          />
                        </svg>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </ScrollArea>

          <div className="flex justify-end gap-3 mt-6">
            <Button
              variant="outline"
              onClick={() => router.push('/dashboard/dms')}
              disabled={isCreating}
            >
              Cancel
            </Button>
            <Button
              onClick={handleStartConversation}
              disabled={!selectedUserId || isCreating}
            >
              {isCreating ? 'Starting...' : 'Start Conversation'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
