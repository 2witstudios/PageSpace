'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { UserPlus, UserMinus, UserCheck, UserX, MessageSquare, MoreVertical, User, Mail } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import useSWR, { mutate } from 'swr';
import { toast } from 'sonner';
import { formatDistanceToNow } from 'date-fns';
import { VerificationRequiredAlert } from '@/components/VerificationRequiredAlert';
import { post, patch, del, fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useSocket } from '@/hooks/useSocket';
import { useNotificationStore } from '@/stores/useNotificationStore';

const fetcher = async (url: string) => {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status}`);
  }
  return response.json();
};

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

export default function ConnectionsPage() {
  const { } = useAuth();
  const router = useRouter();
  const socket = useSocket();
  const [email, setEmail] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isInviting, setIsInviting] = useState(false);
  const [invitableEmail, setInvitableEmail] = useState<string | null>(null);
  const [showVerificationAlert, setShowVerificationAlert] = useState(false);

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

  useEffect(() => {
    if (!socket) return;

    const handleNotification = (notification: { type: string }) => {
      if (notification.type === 'CONNECTION_ACCEPTED') {
        mutate('/api/connections?status=PENDING');
        mutate('/api/connections?status=ACCEPTED');
      } else if (notification.type === 'CONNECTION_REJECTED' || notification.type === 'CONNECTION_REQUEST') {
        mutate('/api/connections?status=PENDING');
      }
    };

    socket.on('notification:new', handleNotification);
    return () => { socket.off('notification:new', handleNotification); };
  }, [socket]);

  const handleSendConnectionRequest = async () => {
    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail) return;

    setInvitableEmail(null);
    setIsSubmitting(true);
    try {
      const response = await fetchWithAuth(`/api/connections/search?email=${encodeURIComponent(trimmedEmail)}`);
      if (!response.ok) throw new Error('Failed to search for user');

      const data = await response.json();

      if (!data.user) {
        const errorMsg: string = data.error || '';
        // Only surface the invite CTA for true "user not found" — not for
        // self-search or existing PENDING/ACCEPTED/BLOCKED relationships,
        // which also return user: null but with a specific reason.
        if (errorMsg.toLowerCase().includes('no user found')) {
          setInvitableEmail(trimmedEmail);
        } else {
          toast.error(errorMsg || 'No user found with this email address');
        }
        return;
      }

      const targetUser = data.user;
      await post('/api/connections', { targetUserId: targetUser.id });

      const recipientLabel = targetUser.displayName || targetUser.name;
      toast.success(`Connection request sent to ${recipientLabel} (${targetUser.email})`);
      setEmail('');
      mutate('/api/connections?status=PENDING');
    } catch (error) {
      const errorMessage = (error as Error).message;
      if (errorMessage.includes('requiresEmailVerification') || errorMessage.includes('verification')) {
        setShowVerificationAlert(true);
        return;
      }

      toast.error(errorMessage || 'Failed to send connection request');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleInviteToPageSpace = async () => {
    if (!invitableEmail) return;

    setIsInviting(true);
    try {
      await post('/api/connections/invite', { email: invitableEmail });
      toast.success(`Connection invite sent to ${invitableEmail}`);
      setEmail('');
      setInvitableEmail(null);
    } catch (error) {
      const errorMessage = (error as Error).message;
      if (errorMessage.includes('already pending')) {
        toast.error(`You already have a pending connection invite for ${invitableEmail}`);
      } else if (errorMessage.includes('requiresEmailVerification') || errorMessage.includes('verification')) {
        setShowVerificationAlert(true);
      } else {
        toast.error(errorMessage || 'Failed to send invite');
      }
    } finally {
      setIsInviting(false);
    }
  };

  const handleConnectionAction = async (connectionId: string, action: 'accept' | 'reject' | 'remove') => {
    try {
      if (action === 'remove') {
        await del(`/api/connections/${connectionId}`);
        toast.success('Connection removed');
      } else {
        await patch(`/api/connections/${connectionId}`, { action });
        toast.success(`Connection ${action}ed`);

        // Optimistically mark the matching CONNECTION_REQUEST notification as actioned
        const { notifications: storeNotifications, updateNotification } =
          useNotificationStore.getState();
        const stale = storeNotifications.find(
          (n) =>
            n.type === 'CONNECTION_REQUEST' &&
            n.metadata &&
            typeof n.metadata === 'object' &&
            'connectionId' in n.metadata &&
            n.metadata.connectionId === connectionId,
        );
        if (stale) {
          updateNotification(stale.id, {
            isRead: true,
            metadata: {
              ...(stale.metadata as Record<string, unknown>),
              actioned: true,
              actionedStatus: action === 'accept' ? 'accepted' : 'rejected',
            },
          });
        }
      }

      // Refresh data
      mutate('/api/connections?status=ACCEPTED');
      mutate('/api/connections?status=PENDING');
    } catch (error) {
      toast.error(`Failed to ${action} connection`);
      console.error('Connection action error:', error);
    }
  };

  const handleStartConversation = async (userId: string) => {
    try {
      const data = await post<{ conversation: { id: string } }>('/api/messages/conversations', { recipientId: userId });
      router.push(`/dashboard/dms/${data.conversation.id}`);
    } catch {
      toast.error('Failed to start conversation');
    }
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
        <TabsList className="flex w-full flex-col sm:grid sm:grid-cols-3 h-auto">
          <TabsTrigger value="connections" className="w-full">
            <span className="truncate">Connections</span>
            {acceptedConnections.length > 0 && <span className="ml-1 shrink-0">({acceptedConnections.length})</span>}
          </TabsTrigger>
          <TabsTrigger value="pending" className="w-full">
            <span className="truncate">Pending</span>
            {pendingConnections.length > 0 && <Badge className="ml-1.5 shrink-0">{pendingConnections.length}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="discover" className="w-full">
            <span className="truncate">Add Connection</span>
          </TabsTrigger>
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
                      <div key={connection.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 border rounded-lg">
                        <div className="flex items-center gap-3 min-w-0">
                          <Avatar className="h-10 w-10 shrink-0">
                            <AvatarImage src={connection.user.image || connection.user.avatarUrl || ''} />
                            <AvatarFallback>{displayName.charAt(0).toUpperCase()}</AvatarFallback>
                          </Avatar>
                          <div className="min-w-0">
                            <p className="font-medium truncate">{displayName}</p>
                            <p className="text-sm text-muted-foreground truncate">{connection.user.email}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0 self-end sm:self-auto">
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label="Message"
                            onClick={() => handleStartConversation(connection.user.id)}
                          >
                            <MessageSquare className="h-4 w-4 sm:mr-2" />
                            <span className="hidden sm:inline">Message</span>
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
                      <div key={connection.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 border rounded-lg">
                        <div className="flex items-center gap-3 min-w-0">
                          <Avatar className="h-10 w-10 shrink-0">
                            <AvatarImage src={connection.user.image || connection.user.avatarUrl || ''} />
                            <AvatarFallback>{displayName.charAt(0).toUpperCase()}</AvatarFallback>
                          </Avatar>
                          <div className="min-w-0">
                            <p className="font-medium truncate">{displayName}</p>
                            <p className="text-sm text-muted-foreground truncate">{connection.user.email}</p>
                            <p className="text-xs text-muted-foreground">
                              {isIncoming ? 'Sent you a request' : 'Request sent'} {' '}
                              {formatDistanceToNow(new Date(connection.requestedAt), { addSuffix: true })}
                            </p>
                            {connection.requestMessage && (
                              <p className="text-sm mt-1 line-clamp-2">{connection.requestMessage}</p>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0 self-end sm:self-auto">
                          {isIncoming ? (
                            <>
                              <Button
                                variant="default"
                                size="sm"
                                aria-label="Accept request"
                                onClick={() => handleConnectionAction(connection.id, 'accept')}
                              >
                                <UserCheck className="h-4 w-4 sm:mr-2" />
                                <span className="hidden sm:inline">Accept</span>
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                aria-label="Decline request"
                                onClick={() => handleConnectionAction(connection.id, 'reject')}
                              >
                                <UserX className="h-4 w-4 sm:mr-2" />
                                <span className="hidden sm:inline">Decline</span>
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
              {showVerificationAlert && (
                <div className="mb-4">
                  <VerificationRequiredAlert onDismiss={() => setShowVerificationAlert(false)} />
                </div>
              )}
              <div className="space-y-4">
                <div className="flex gap-2">
                  <Input
                    type="email"
                    placeholder="Enter email address"
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      if (invitableEmail) setInvitableEmail(null);
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && handleSendConnectionRequest()}
                    disabled={isSubmitting || isInviting}
                  />
                  <Button
                    onClick={handleSendConnectionRequest}
                    disabled={isSubmitting || isInviting || !email.trim()}
                  >
                    <UserPlus className="h-4 w-4 mr-2" />
                    {isSubmitting ? 'Searching...' : 'Find User'}
                  </Button>
                </div>
                {invitableEmail && (
                  <div className="flex items-start gap-3 rounded-lg border border-dashed p-4">
                    <Mail className="h-5 w-5 text-muted-foreground mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">User not found</p>
                      <p className="text-sm text-muted-foreground truncate">
                        {invitableEmail} is not on PageSpace yet.
                      </p>
                    </div>
                    <Button
                      size="sm"
                      onClick={handleInviteToPageSpace}
                      disabled={isInviting}
                    >
                      <Mail className="h-4 w-4 mr-2" />
                      {isInviting ? 'Sending...' : 'Invite to PageSpace'}
                    </Button>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}