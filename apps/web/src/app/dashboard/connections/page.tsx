'use client';

import { useState } from 'react';
import { useAuth } from '@/hooks/use-auth';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Search, UserPlus, UserMinus, UserCheck, UserX, MessageSquare, MoreVertical, User } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import useSWR, { mutate } from 'swr';
import { toast } from 'sonner';
import { formatDistanceToNow } from 'date-fns';

const fetcher = (url: string) => fetch(url).then((res) => res.json());

interface Connection {
  id: string;
  status: 'PENDING' | 'ACCEPTED' | 'BLOCKED';
  requestedAt: string;
  acceptedAt: string | null;
  requestMessage: string | null;
  user: {
    id: string;
    name: string;
    email: string;
    image: string | null;
    username: string | null;
    displayName: string | null;
    bio: string | null;
    avatarUrl: string | null;
  };
  isRequester: boolean;
}

interface SearchResult {
  id: string;
  name: string;
  email: string;
  image: string | null;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
}

export default function ConnectionsPage() {
  const { } = useAuth();
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [sendingRequest, setSendingRequest] = useState<string | null>(null);

  // Fetch accepted connections
  const { data: acceptedData, error: acceptedError } = useSWR<{ connections: Connection[] }>(
    '/api/connections?status=ACCEPTED',
    fetcher
  );

  // Fetch pending connections
  const { data: pendingData, error: pendingError } = useSWR<{ connections: Connection[] }>(
    '/api/connections?status=PENDING',
    fetcher
  );

  const acceptedConnections = acceptedData?.connections || [];
  const pendingConnections = pendingData?.connections || [];

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;

    setIsSearching(true);
    setSearchResults([]);

    try {
      const response = await fetch(`/api/connections/search?email=${encodeURIComponent(searchQuery)}`);
      if (!response.ok) throw new Error('Search failed');

      const data = await response.json();

      if (data.error) {
        toast.error(data.error);
      } else if (data.user) {
        setSearchResults([data.user]);
      } else {
        toast.info('No user found with this email address');
      }
    } catch (error) {
      toast.error('Failed to search users');
      console.error('Search error:', error);
    } finally {
      setIsSearching(false);
    }
  };

  const handleSendRequest = async (targetUserId: string) => {
    setSendingRequest(targetUserId);
    try {
      const response = await fetch('/api/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUserId }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to send request');
      }

      toast.success('Connection request sent');
      setSearchResults(prev => prev.filter(u => u.id !== targetUserId));
      mutate('/api/connections?status=PENDING');
    } catch (error) {
      toast.error((error as Error).message || 'Failed to send connection request');
    } finally {
      setSendingRequest(null);
    }
  };

  const handleConnectionAction = async (connectionId: string, action: 'accept' | 'reject' | 'remove') => {
    try {
      if (action === 'remove') {
        const response = await fetch(`/api/connections/${connectionId}`, {
          method: 'DELETE',
        });
        if (!response.ok) throw new Error('Failed to remove connection');
        toast.success('Connection removed');
      } else {
        const response = await fetch(`/api/connections/${connectionId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        });
        if (!response.ok) throw new Error(`Failed to ${action} connection`);
        toast.success(`Connection ${action}ed`);
      }

      // Refresh data
      mutate('/api/connections?status=ACCEPTED');
      mutate('/api/connections?status=PENDING');
    } catch (error) {
      toast.error(`Failed to ${action} connection`);
      console.error('Connection action error:', error);
    }
  };

  const handleStartConversation = (userId: string) => {
    // Create or navigate to conversation
    fetch('/api/messages/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipientId: userId }),
    })
      .then(res => res.json())
      .then(data => {
        router.push(`/dashboard/messages/${data.conversation.id}`);
      })
      .catch(() => {
        toast.error('Failed to start conversation');
      });
  };

  return (
    <div className="container max-w-6xl mx-auto py-8 px-4">
      <div className="mb-8">
        <h1 className="text-3xl font-bold">Connections</h1>
        <p className="text-muted-foreground mt-2">
          Manage your connections and find new people to connect with
        </p>
      </div>

      <Tabs defaultValue="connections" className="space-y-6">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="connections">
            Connections {acceptedConnections.length > 0 && `(${acceptedConnections.length})`}
          </TabsTrigger>
          <TabsTrigger value="pending">
            Pending {pendingConnections.length > 0 && <Badge className="ml-2">{pendingConnections.length}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="discover">Add Connection</TabsTrigger>
        </TabsList>

        {/* Accepted Connections */}
        <TabsContent value="connections">
          <Card>
            <CardHeader>
              <CardTitle>Your Connections</CardTitle>
              <CardDescription>
                People you&apos;re connected with on PageSpace
              </CardDescription>
            </CardHeader>
            <CardContent>
              {acceptedError ? (
                <p className="text-center text-muted-foreground py-8">
                  Failed to load connections
                </p>
              ) : acceptedConnections.length === 0 ? (
                <div className="text-center py-8">
                  <User className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                  <p className="text-muted-foreground">
                    You don&apos;t have any connections yet
                  </p>
                  <p className="text-sm text-muted-foreground mt-2">
                    Search for people to connect with in the Discover tab
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {acceptedConnections.map((connection) => {
                    const displayName = connection.user.displayName || connection.user.name;
                    return (
                      <div key={connection.id} className="flex items-center justify-between p-4 border rounded-lg">
                        <div className="flex items-center gap-4">
                          <Avatar className="h-10 w-10">
                            <AvatarImage src={connection.user.image || connection.user.avatarUrl || ''} />
                            <AvatarFallback>{displayName.charAt(0).toUpperCase()}</AvatarFallback>
                          </Avatar>
                          <div>
                            <p className="font-medium">{displayName}</p>
                            <p className="text-sm text-muted-foreground">{connection.user.email}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleStartConversation(connection.user.id)}
                          >
                            <MessageSquare className="h-4 w-4 mr-2" />
                            Message
                          </Button>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon">
                                <MoreVertical className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onClick={() => handleConnectionAction(connection.id, 'remove')}
                                className="text-destructive"
                              >
                                <UserMinus className="h-4 w-4 mr-2" />
                                Remove Connection
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Pending Connections */}
        <TabsContent value="pending">
          <Card>
            <CardHeader>
              <CardTitle>Pending Requests</CardTitle>
              <CardDescription>
                Connection requests waiting for your response
              </CardDescription>
            </CardHeader>
            <CardContent>
              {pendingError ? (
                <p className="text-center text-muted-foreground py-8">
                  Failed to load pending requests
                </p>
              ) : pendingConnections.length === 0 ? (
                <p className="text-center text-muted-foreground py-8">
                  No pending connection requests
                </p>
              ) : (
                <div className="space-y-4">
                  {pendingConnections.map((connection) => {
                    const displayName = connection.user.displayName || connection.user.name;
                    const isIncoming = !connection.isRequester;

                    return (
                      <div key={connection.id} className="flex items-center justify-between p-4 border rounded-lg">
                        <div className="flex items-center gap-4">
                          <Avatar className="h-10 w-10">
                            <AvatarImage src={connection.user.image || connection.user.avatarUrl || ''} />
                            <AvatarFallback>{displayName.charAt(0).toUpperCase()}</AvatarFallback>
                          </Avatar>
                          <div>
                            <p className="font-medium">{displayName}</p>
                            <p className="text-sm text-muted-foreground">{connection.user.email}</p>
                            <p className="text-xs text-muted-foreground">
                              {isIncoming ? 'Sent you a request' : 'Request sent'} {' '}
                              {formatDistanceToNow(new Date(connection.requestedAt), { addSuffix: true })}
                            </p>
                            {connection.requestMessage && (
                              <p className="text-sm mt-1">{connection.requestMessage}</p>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {isIncoming ? (
                            <>
                              <Button
                                variant="default"
                                size="sm"
                                onClick={() => handleConnectionAction(connection.id, 'accept')}
                              >
                                <UserCheck className="h-4 w-4 mr-2" />
                                Accept
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleConnectionAction(connection.id, 'reject')}
                              >
                                <UserX className="h-4 w-4 mr-2" />
                                Decline
                              </Button>
                            </>
                          ) : (
                            <Badge variant="secondary">Pending</Badge>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Add Connection by Email */}
        <TabsContent value="discover">
          <Card>
            <CardHeader>
              <CardTitle>Add Connection</CardTitle>
              <CardDescription>
                Connect with other PageSpace users by entering their email address
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="flex gap-2">
                  <Input
                    type="email"
                    placeholder="Enter email address"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                  />
                  <Button onClick={handleSearch} disabled={isSearching || !searchQuery.trim()}>
                    <Search className="h-4 w-4 mr-2" />
                    Add
                  </Button>
                </div>

                {searchResults.length > 0 && (
                  <div className="space-y-4">
                    {searchResults.map((user) => {
                      const displayName = user.displayName || user.name;
                      return (
                        <div key={user.id} className="flex items-center justify-between p-4 border rounded-lg">
                          <div className="flex items-center gap-4">
                            <Avatar className="h-10 w-10">
                              <AvatarImage src={user.image || user.avatarUrl || ''} />
                              <AvatarFallback>{displayName.charAt(0).toUpperCase()}</AvatarFallback>
                            </Avatar>
                            <div>
                              <p className="font-medium">{displayName}</p>
                              <p className="text-sm text-muted-foreground">{user.email}</p>
                              {user.bio && (
                                <p className="text-sm text-muted-foreground line-clamp-1 mt-1">{user.bio}</p>
                              )}
                            </div>
                          </div>
                          <Button
                            onClick={() => handleSendRequest(user.id)}
                            disabled={sendingRequest === user.id}
                          >
                            <UserPlus className="h-4 w-4 mr-2" />
                            {sendingRequest === user.id ? 'Sending...' : 'Send Request'}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                )}

                {isSearching && (
                  <p className="text-center text-muted-foreground py-8">Searching...</p>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}