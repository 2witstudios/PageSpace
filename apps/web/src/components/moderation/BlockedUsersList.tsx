'use client';

import useSWR from 'swr';
import { toast } from 'sonner';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { fetchWithAuth, del } from '@/lib/auth/auth-fetch';
import { useAuth } from '@/hooks/useAuth';

interface BlockedConnection {
  id: string;
  blockedBy: string | null;
  user: {
    id: string;
    name: string;
    image: string | null;
    displayName: string | null;
    avatarUrl: string | null;
  };
}

const fetcher = async (url: string): Promise<{ connections: BlockedConnection[] }> => {
  const response = await fetchWithAuth(url);
  if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`);
  return response.json();
};

/** People the current user has blocked, each with an Unblock action. */
export function BlockedUsersList() {
  const { user } = useAuth();
  const { data, mutate } = useSWR('/api/connections?status=BLOCKED', fetcher);

  // A BLOCKED row is visible to both people; only the blocker can lift it.
  const blocked = (data?.connections ?? []).filter((c) => c.blockedBy === user?.id);
  if (blocked.length === 0) return null;

  const unblock = async (connection: BlockedConnection) => {
    const name = connection.user.displayName || connection.user.name;
    try {
      await del(`/api/users/${encodeURIComponent(connection.user.id)}/block`);
      toast.success(`${name} is unblocked`);
      await mutate();
    } catch {
      toast.error(`Could not unblock ${name}`);
    }
  };

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-muted-foreground">Blocked</h3>
      {blocked.map((connection) => {
        const name = connection.user.displayName || connection.user.name;
        return (
          <div key={connection.id} className="flex items-center justify-between gap-3 p-4 border rounded-lg">
            <div className="flex items-center gap-3 min-w-0">
              <Avatar className="h-10 w-10 shrink-0">
                <AvatarImage src={connection.user.image || connection.user.avatarUrl || ''} />
                <AvatarFallback>{name.charAt(0).toUpperCase()}</AvatarFallback>
              </Avatar>
              <p className="font-medium truncate">{name}</p>
            </div>
            <Button variant="outline" size="sm" aria-label={`Unblock ${name}`} onClick={() => void unblock(connection)}>
              Unblock
            </Button>
          </div>
        );
      })}
    </div>
  );
}
