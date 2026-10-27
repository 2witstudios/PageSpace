'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/retained/hooks/useAuth';
import { useRouter } from '@/retained-adapters/navigation';
import { Avatar, AvatarFallback, AvatarImage } from '@/retained/components/ui/avatar';
import { Button } from '@/retained/components/ui/button';
import { Input } from '@/retained/components/ui/input';
import { UserCheck, UserX, MessageSquare, MoreVertical, UserMinus, Ban, Mail } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/retained/components/ui/dropdown-menu';
import useSWR, { useSWRConfig } from 'swr';
import { toast } from 'sonner';
import { formatDistanceToNow } from 'date-fns';
import { VerificationRequiredAlert } from '@/retained/components/VerificationRequiredAlert';
import { post, patch, del, fetchWithAuth } from '@/retained/lib/auth/auth-fetch';
import { useSocket } from '@/retained/hooks/useSocket';
import { useNotificationStore } from '@/retained/stores/useNotificationStore';
import {
  SettingsGroup,
  SettingsScreen,
  SettingsSection,
} from '@/ui/settings/settings-screen/settings-screen';

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
  blockedBy?: string | null;
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
  const { mutate } = useSWRConfig();
  const { user } = useAuth();
  const router = useRouter();
  const socket = useSocket();
  const [email, setEmail] = useState('');
  const [isInviting, setIsInviting] = useState(false);
  const [filter, setFilter] = useState('');
  const [showVerificationAlert, setShowVerificationAlert] = useState(false);

  // Fetch accepted connections
  const { data: acceptedData, error: acceptedError } = useSWR<{ connections: Connection[] }>(
    '/api/connections?status=ACCEPTED',
    fetcher
  );

  // Fetch pending connections
  const { data: pendingData } = useSWR<{ connections: Connection[] }>(
    '/api/connections?status=PENDING',
    fetcher
  );

  // Fetch blocked connections; only the blocker can lift a block
  const { data: blockedData } = useSWR<{ connections: Connection[] }>(
    '/api/connections?status=BLOCKED',
    fetcher
  );

  const acceptedConnections = acceptedData?.connections || [];
  const pendingConnections = pendingData?.connections || [];
  const blockedConnections = (blockedData?.connections || []).filter(
    (connection) => connection.blockedBy === user?.id
  );

  const normalizedFilter = filter.trim().toLowerCase();
  const visibleAccepted = normalizedFilter
    ? acceptedConnections.filter((connection) => {
        const haystack = [
          connection.user.displayName,
          connection.user.name,
          connection.user.username,
          connection.user.email,
        ];
        return haystack.some((value) => value?.toLowerCase().includes(normalizedFilter));
      })
    : acceptedConnections;

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

  // The invite endpoint handles both members (a PENDING request) and non-members (an email invite),
  // and enforces the real rules. Its outcome is reported uniformly so it reveals nothing about
  // another person's account or relationship state.
  const handleSendRequest = async () => {
    const targetEmail = email.trim().toLowerCase();
    if (!targetEmail) return;

    setIsInviting(true);
    try {
      await post('/api/connections/invite', { email: targetEmail });
    } catch (error) {
      const errorMessage = (error as Error).message ?? '';
      if (/verification|requiresEmailVerification/i.test(errorMessage)) {
        setShowVerificationAlert(true);
        return;
      }
      if (/too many/i.test(errorMessage)) {
        toast.error('Too many requests right now. Please try again later.');
        return;
      }
      // Everything else falls through to the uniform confirmation below.
    } finally {
      setIsInviting(false);
    }
    toast.success(`If ${targetEmail} can be reached, your connection request is on its way.`);
    setEmail('');
    mutate('/api/connections?status=PENDING');
  };

  const handleBlockUser = async (userId: string, name: string) => {
    if (!window.confirm(`Block ${name}? Neither of you will be able to send the other direct messages.`)) return;
    try {
      await post(`/api/users/${encodeURIComponent(userId)}/block`);
      toast.success(`${name} is blocked`);
      mutate('/api/connections?status=ACCEPTED');
      mutate('/api/connections?status=BLOCKED');
    } catch (error) {
      toast.error('Failed to block user');
      console.error('Block user error:', error);
    }
  };

  const handleUnblockUser = async (userId: string, name: string) => {
    try {
      await del(`/api/users/${encodeURIComponent(userId)}/block`);
      toast.success(`${name} is unblocked`);
      mutate('/api/connections?status=BLOCKED');
    } catch {
      toast.error(`Could not unblock ${name}`);
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
    <SettingsScreen
      title="Connections"
      lede="People you’ve connected with can message you directly and be added to your drives."
    >
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSendRequest();
        }}
      >
        <label htmlFor="cn-email" className="text-sm font-medium text-foreground">
          Send a connection request
        </label>
        <div className="flex gap-2">
          <Input
            id="cn-email"
            type="email"
            placeholder="Enter email address"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={isInviting}
          />
          <Button type="submit" disabled={isInviting || !email.trim()}>
            <Mail className="mr-2 h-4 w-4" />
            {isInviting ? 'Sending...' : 'Send request'}
          </Button>
        </div>
        <span className="text-xs text-muted-foreground">
          If they don’t have an account yet, we’ll email them an invite instead.
        </span>
        {showVerificationAlert && (
          <div className="mt-2">
            <VerificationRequiredAlert onDismiss={() => setShowVerificationAlert(false)} />
          </div>
        )}
      </form>

      {pendingConnections.length > 0 && (
        <SettingsSection title={`Pending ${pendingConnections.length}`}>
          <SettingsGroup>
            {pendingConnections.map((connection) => {
              const displayName = connection.user.displayName || connection.user.name;
              const isIncoming = !connection.isRequester;
              const when = formatDistanceToNow(new Date(connection.requestedAt), { addSuffix: true });

              return (
                <div key={connection.id} className="flex items-start gap-3 px-4 py-3">
                  <Avatar className="h-10 w-10 shrink-0">
                    <AvatarImage src={connection.user.image || connection.user.avatarUrl || ''} />
                    <AvatarFallback>{displayName.charAt(0).toUpperCase()}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">
                      {displayName}{' '}
                      <span className="font-normal text-muted-foreground">{connection.user.email}</span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {isIncoming ? `Sent you a request ${when}` : when}
                    </p>
                    {connection.requestMessage && (
                      <p className="mt-1 text-sm leading-relaxed text-foreground">“{connection.requestMessage}”</p>
                    )}
                  </div>
                  {isIncoming ? (
                    <div className="flex shrink-0 items-center gap-2">
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
                    </div>
                  ) : (
                    <span className="shrink-0 text-xs text-muted-foreground">Sent · awaiting reply</span>
                  )}
                </div>
              );
            })}
          </SettingsGroup>
        </SettingsSection>
      )}

      <SettingsSection
        title={`Your connections ${acceptedConnections.length}`}
        actions={
          <Input
            aria-label="Filter connections"
            placeholder="Filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="h-8 w-44"
          />
        }
      >
        {acceptedError ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Failed to load connections</p>
        ) : acceptedConnections.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">You don&apos;t have any connections yet.</p>
        ) : (
          <SettingsGroup>
            {visibleAccepted.map((connection) => {
              const displayName = connection.user.displayName || connection.user.name;
              const since = formatDistanceToNow(new Date(connection.acceptedAt ?? connection.requestedAt), { addSuffix: true });
              return (
                <div key={connection.id} className="flex items-center gap-3 px-4 py-3">
                  <Avatar className="h-10 w-10 shrink-0">
                    <AvatarImage src={connection.user.image || connection.user.avatarUrl || ''} />
                    <AvatarFallback>{displayName.charAt(0).toUpperCase()}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">
                      {displayName}{' '}
                      {connection.user.username && (
                        <span className="font-normal text-muted-foreground">@{connection.user.username}</span>
                      )}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {connection.user.email} · connected {since}
                    </p>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => handleStartConversation(connection.user.id)}>
                    <MessageSquare className="mr-2 h-4 w-4" />
                    Message
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" aria-label={`More actions for ${displayName}`}>
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={() => handleConnectionAction(connection.id, 'remove')}
                        className="text-destructive"
                      >
                        <UserMinus className="mr-2 h-4 w-4" />
                        Remove Connection
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => void handleBlockUser(connection.user.id, displayName)}
                        className="text-destructive"
                      >
                        <Ban className="mr-2 h-4 w-4" />
                        Block
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              );
            })}
            {visibleAccepted.length === 0 && (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">No connections match “{filter.trim()}”.</p>
            )}
          </SettingsGroup>
        )}
      </SettingsSection>

      <SettingsSection title={`Blocked ${blockedConnections.length}`}>
        {blockedConnections.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No one is blocked. People you block can’t message you or send you connection requests.
          </p>
        ) : (
          <SettingsGroup>
            {blockedConnections.map((connection) => {
              const name = connection.user.displayName || connection.user.name;
              return (
                <div key={connection.id} className="flex items-center gap-3 px-4 py-3">
                  <Avatar className="h-10 w-10 shrink-0">
                    <AvatarImage src={connection.user.image || connection.user.avatarUrl || ''} />
                    <AvatarFallback>{name.charAt(0).toUpperCase()}</AvatarFallback>
                  </Avatar>
                  <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{name}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={`Unblock ${name}`}
                    onClick={() => void handleUnblockUser(connection.user.id, name)}
                  >
                    Unblock
                  </Button>
                </div>
              );
            })}
          </SettingsGroup>
        )}
      </SettingsSection>
    </SettingsScreen>
  );
}
