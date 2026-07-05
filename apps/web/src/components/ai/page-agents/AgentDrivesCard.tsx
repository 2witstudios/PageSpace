import React, { useMemo, useState } from 'react';
import useSWR from 'swr';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Loader2, Network, X } from 'lucide-react';
import { toast } from 'sonner';
import { fetchWithAuth, post, patch, del } from '@/lib/auth/auth-fetch';

interface AgentDrive {
  driveId: string;
  driveName: string;
  driveSlug: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  customRoleId: string | null;
  isHome: boolean;
  includeContext: boolean;
}

interface DriveOption {
  id: string;
  name: string;
  slug: string;
}

const jsonFetcher = async (url: string) => {
  const res = await fetchWithAuth(url);
  if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
  return res.json();
};

/**
 * Manages the set of drives an AI agent can access. The agent's home drive is
 * always present and cannot be removed; other drives can be added (the agent
 * inherits the user's access to that drive) or removed.
 */
export function AgentDrivesCard({ agentPageId }: { agentPageId: string }) {
  const { data, mutate, isLoading } = useSWR<{ drives: AgentDrive[] }>(
    `/api/ai/page-agents/${agentPageId}/drives`,
    jsonFetcher,
  );
  const { data: allDrives } = useSWR<DriveOption[]>('/api/drives', jsonFetcher);

  const [selected, setSelected] = useState<string>('');
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const agentDrives = useMemo(() => data?.drives ?? [], [data]);
  const memberIds = useMemo(() => new Set(agentDrives.map((d) => d.driveId)), [agentDrives]);
  const available = useMemo(
    () => (allDrives ?? []).filter((d) => !memberIds.has(d.id)),
    [allDrives, memberIds],
  );

  const handleAdd = async () => {
    if (!selected) return;
    setAdding(true);
    try {
      await post(`/api/ai/page-agents/${agentPageId}/drives`, { driveId: selected });
      toast.success('Agent added to drive');
      setSelected('');
      await mutate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to add agent to drive');
    } finally {
      setAdding(false);
    }
  };

  const handleToggleIncludeContext = async (driveId: string, includeContext: boolean) => {
    setTogglingId(driveId);
    // Optimistic update, reverted on failure via mutate(data, false) restoring the cache.
    const previous = data;
    await mutate(
      (current) =>
        current && {
          drives: current.drives.map((d) => (d.driveId === driveId ? { ...d, includeContext } : d)),
        },
      false,
    );
    try {
      await patch(`/api/ai/page-agents/${agentPageId}/drives/${driveId}`, { includeContext });
      await mutate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update drive context setting');
      await mutate(previous, false);
    } finally {
      setTogglingId(null);
    }
  };

  const handleRemove = async (driveId: string) => {
    setRemovingId(driveId);
    try {
      await del(`/api/ai/page-agents/${agentPageId}/drives/${driveId}`);
      toast.success('Agent removed from drive');
      await mutate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to remove agent from drive');
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Network className="h-5 w-5" />
          <div>
            <CardTitle className="text-lg">Drives this agent can access</CardTitle>
            <CardDescription>
              The agent can read and act in these drives using its tools, inheriting your access to each.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        ) : (
          <ul className="space-y-2">
            {agentDrives.map((drive) => (
              <li
                key={drive.driveId}
                className="flex items-center justify-between rounded-md border px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{drive.driveName}</span>
                  {drive.isHome ? (
                    <Badge variant="outline">Home</Badge>
                  ) : drive.role === 'ADMIN' || drive.role === 'OWNER' ? (
                    <Badge className="bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300">Admin</Badge>
                  ) : (
                    <Badge className="bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300">Member</Badge>
                  )}
                </div>
                {!drive.isHome && (
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={drive.includeContext}
                        disabled={togglingId === drive.driveId}
                        onCheckedChange={(checked) => handleToggleIncludeContext(drive.driveId, checked)}
                        aria-label={`Carry ${drive.driveName}'s workspace instructions into this agent`}
                      />
                      <span className="text-xs text-muted-foreground">Carry context</span>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRemove(drive.driveId)}
                      disabled={removingId === drive.driveId}
                      aria-label={`Remove access to ${drive.driveName}`}
                    >
                      {removingId === drive.driveId ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <X className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-center gap-2">
          <Select value={selected} onValueChange={setSelected} disabled={available.length === 0 || adding}>
            <SelectTrigger className="h-8 flex-1 text-sm">
              <SelectValue placeholder={available.length === 0 ? 'No more drives to add' : 'Add a drive…'} />
            </SelectTrigger>
            <SelectContent>
              {available.map((drive) => (
                <SelectItem key={drive.id} value={drive.id}>
                  {drive.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button type="button" size="sm" onClick={handleAdd} disabled={!selected || adding}>
            {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Add'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
