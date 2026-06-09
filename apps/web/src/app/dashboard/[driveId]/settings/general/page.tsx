'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { ChevronLeft, Shield, Users, Bot, Plug2, Loader2 } from 'lucide-react';
import { useDriveStore } from '@/hooks/useDrive';
import { toast } from 'sonner';
import { fetchWithAuth, patch } from '@/lib/auth/auth-fetch';
import useSWR from 'swr';

interface DriveMember {
  id: string;
  userId: string;
  user: { id: string; email: string; name?: string };
  profile?: { username?: string; avatar?: string | null };
}

const fetcher = (url: string) => fetchWithAuth(url).then((r) => r.json());

export default function GeneralSettingsPage() {
  const params = useParams();
  const router = useRouter();
  const driveId = params.driveId as string;
  const drives = useDriveStore((state) => state.drives);
  const isLoading = useDriveStore((state) => state.isLoading);
  const fetchDrives = useDriveStore((state) => state.fetchDrives);

  const [name, setName] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    fetchDrives();
  }, [fetchDrives]);

  const drive = drives.find((d) => d.id === driveId);
  const canManage = drive?.isOwned || drive?.role === 'ADMIN';

  useEffect(() => {
    if (drive) setName(drive.name);
  }, [drive]);

  const { data: members } = useSWR<DriveMember[]>(
    drive ? `/api/drives/${driveId}/members` : null,
    fetcher
  );
  const { data: agentMembers } = useSWR<{ id: string }[]>(
    drive ? `/api/drives/${driveId}/agents/members` : null,
    fetcher
  );
  const { data: appMembers } = useSWR<{ id: string }[]>(
    drive ? `/api/drives/${driveId}/apps/members` : null,
    fetcher
  );

  const handleSave = async () => {
    if (isSaving || !name.trim()) return;
    setIsSaving(true);
    try {
      await patch(`/api/drives/${driveId}`, { name: name.trim() });
      await fetchDrives();
      toast.success('Drive renamed');
    } catch {
      toast.error('Failed to rename drive');
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="container mx-auto px-4 py-10 sm:px-6 lg:px-10 max-w-2xl space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (!drive || !canManage) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <Shield className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold mb-2">Access Denied</h2>
          <p className="text-muted-foreground">Only drive owners and admins can access settings.</p>
          <Button
            variant="outline"
            className="mt-4"
            onClick={() => router.push(`/dashboard/${driveId}`)}
          >
            Go Back
          </Button>
        </div>
      </div>
    );
  }

  const humanCount = members?.length ?? 0;
  const agentCount = agentMembers?.length ?? 0;
  const appCount = appMembers?.length ?? 0;
  const topAvatars = (members ?? []).slice(0, 5);

  return (
    <div className="container mx-auto px-4 py-10 sm:px-6 lg:px-10 max-w-2xl space-y-6">
      <div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push(`/dashboard/${driveId}/settings`)}
          className="mb-4"
        >
          <ChevronLeft className="h-4 w-4 mr-1" />
          Back to Settings
        </Button>
        <h1 className="text-3xl font-bold mb-1">General</h1>
        <p className="text-muted-foreground">Basic drive settings</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Drive Name</CardTitle>
          <CardDescription>Update the display name for this drive</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="drive-name">Name</Label>
            <Input
              id="drive-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSave()}
              placeholder="Drive name"
            />
          </div>
          <Button
            onClick={handleSave}
            disabled={isSaving || !name.trim() || name.trim() === drive.name}
          >
            {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Save
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Members Overview</CardTitle>
          <CardDescription>Current members of this drive</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-6">
            <div className="flex items-center gap-2 text-sm">
              <Users className="h-4 w-4 text-muted-foreground" />
              <span>
                {humanCount} {humanCount === 1 ? 'member' : 'members'}
              </span>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <Bot className="h-4 w-4 text-muted-foreground" />
              <span>
                {agentCount} {agentCount === 1 ? 'agent' : 'agents'}
              </span>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <Plug2 className="h-4 w-4 text-muted-foreground" />
              <span>
                {appCount} {appCount === 1 ? 'app' : 'apps'}
              </span>
            </div>
          </div>
          {topAvatars.length > 0 && (
            <div className="flex -space-x-2">
              {topAvatars.map((m) => (
                <Avatar key={m.id} className="h-8 w-8 border-2 border-background">
                  <AvatarImage
                    src={m.profile?.avatar ?? undefined}
                    alt={m.user.name ?? m.user.email}
                  />
                  <AvatarFallback className="text-xs">
                    {(m.user.name ?? m.user.email).slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
              ))}
            </div>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => router.push(`/dashboard/${driveId}/members`)}
          >
            Manage Members
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
