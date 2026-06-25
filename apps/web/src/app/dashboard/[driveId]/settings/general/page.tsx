'use client';

import { useState, useEffect, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { ChevronLeft, Shield, Users, Bot, Plug2, Loader2, Home, Image as ImageIcon } from 'lucide-react';
import Link from 'next/link';
import { useDriveStore } from '@/hooks/useDrive';
import { usePageTree } from '@/hooks/usePageTree';
import { findNodeAndParent } from '@/lib/tree/tree-utils';
import { useEditingStore } from '@/stores/useEditingStore';
import { toast } from 'sonner';
import { fetchWithAuth, patch } from '@/lib/auth/auth-fetch';
import useSWR from 'swr';

interface DriveMember {
  id: string;
  userId: string;
  user: { id: string; email: string; name?: string };
  profile?: { username?: string; avatar?: string | null };
}

interface MembersResponse {
  members: DriveMember[];
}

interface AgentMembersResponse {
  agentMembers: { id: string }[];
}

interface AppMembersResponse {
  appMembers: { id: string }[];
}

const fetcher = (url: string) => fetchWithAuth(url).then((r) => r.json());

export default function GeneralSettingsPage() {
  const params = useParams();
  const router = useRouter();
  const driveId = params.driveId as string;
  const drives = useDriveStore((state) => state.drives);
  const isLoading = useDriveStore((state) => state.isLoading);
  const fetchDrives = useDriveStore((state) => state.fetchDrives);
  const updateDriveInStore = useDriveStore((state) => state.updateDrive);
  const { tree } = usePageTree(driveId);

  const [name, setName] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [ogImage, setOgImage] = useState('');
  const [isSavingOgImage, setIsSavingOgImage] = useState(false);
  const [isClearingHomePage, setIsClearingHomePage] = useState(false);
  const startEditing = useEditingStore((s) => s.startEditing);
  const endEditing = useEditingStore((s) => s.endEditing);

  useEffect(() => {
    return () => endEditing('drive-settings-rename');
  }, [endEditing]);

  useEffect(() => {
    fetchDrives();
  }, [fetchDrives]);

  const drive = drives.find((d) => d.id === driveId);
  const canManage = drive?.isOwned || drive?.role === 'ADMIN';

  useEffect(() => {
    if (drive && !useEditingStore.getState().isAnyEditing()) setName(drive.name);
  }, [drive]);

  useEffect(() => {
    if (drive) setOgImage(drive.publishDefaultOgImageUrl ?? '');
  }, [drive]);

  const { data: membersData } = useSWR<MembersResponse>(
    drive ? `/api/drives/${driveId}/members` : null,
    fetcher
  );
  const { data: agentMembersData } = useSWR<AgentMembersResponse>(
    drive ? `/api/drives/${driveId}/agents/members` : null,
    fetcher
  );
  const { data: appMembersData } = useSWR<AppMembersResponse>(
    drive ? `/api/drives/${driveId}/apps/members` : null,
    fetcher
  );

  const homePageId = drive?.homePageId ?? null;
  // Memoized: the controlled name input re-renders this page per keystroke,
  // and findNodeAndParent is a full tree walk.
  const homePageNode = useMemo(
    () => (homePageId ? findNodeAndParent(tree, homePageId)?.node ?? null : null),
    [tree, homePageId]
  );

  const handleClearHomePage = async () => {
    if (isClearingHomePage) return;
    setIsClearingHomePage(true);
    try {
      await patch(`/api/drives/${driveId}`, { homePageId: null });
      updateDriveInStore(driveId, { homePageId: null });
      toast.success('Home page cleared');
    } catch {
      toast.error('Failed to clear home page');
    } finally {
      setIsClearingHomePage(false);
    }
  };

  const handleSaveOgImage = async (clear = false) => {
    if (isSavingOgImage) return;
    const next = clear ? '' : ogImage.trim();
    setIsSavingOgImage(true);
    try {
      await patch(`/api/drives/${driveId}`, { publishDefaultOgImageUrl: next });
      updateDriveInStore(driveId, { publishDefaultOgImageUrl: next || null });
      if (clear) setOgImage('');
      toast.success(clear ? 'Default share image cleared' : 'Default share image saved');
    } catch {
      toast.error('Failed to save default share image');
    } finally {
      setIsSavingOgImage(false);
    }
  };

  const handleSave = async () => {
    const nextName = name.trim();
    if (isSaving || !nextName || nextName === drive?.name) return;
    setIsSaving(true);
    try {
      await patch(`/api/drives/${driveId}`, { name: nextName });
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

  const humanCount = membersData?.members?.length ?? 0;
  const agentCount = agentMembersData?.agentMembers?.length ?? 0;
  const appCount = appMembersData?.appMembers?.length ?? 0;
  const topAvatars = (membersData?.members ?? []).slice(0, 5);

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
              onFocus={() => startEditing('drive-settings-rename', 'form', { componentName: 'GeneralSettingsPage' })}
              onBlur={() => endEditing('drive-settings-rename')}
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
          <CardTitle>Home Page</CardTitle>
          <CardDescription>The page people land on when they enter this drive</CardDescription>
        </CardHeader>
        <CardContent>
          {homePageId ? (
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2 text-sm min-w-0">
                <Home className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <Link
                  href={`/dashboard/${driveId}/${homePageId}`}
                  className="truncate font-medium hover:underline"
                >
                  {homePageNode?.title ?? 'Unknown page'}
                </Link>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleClearHomePage}
                disabled={isClearingHomePage}
              >
                {isClearingHomePage && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Clear
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              None — right-click a page in the sidebar to set one
            </p>
          )}
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

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ImageIcon className="h-4 w-4" />
            Default Share Image
          </CardTitle>
          <CardDescription>
            The Open Graph image used when a published page has no image of its own. Recommended 1200×630.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="default-og-image">Image URL</Label>
            <Input
              id="default-og-image"
              type="url"
              value={ogImage}
              onChange={(e) => setOgImage(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSaveOgImage()}
              placeholder="https://…"
            />
          </div>
          {ogImage.trim() && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={ogImage.trim()}
              alt="Default share image preview"
              className="max-h-40 w-full rounded-md border object-contain bg-muted"
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
            />
          )}
          <div className="flex gap-2">
            <Button
              onClick={() => handleSaveOgImage()}
              disabled={isSavingOgImage || ogImage.trim() === (drive.publishDefaultOgImageUrl ?? '')}
            >
              {isSavingOgImage && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save
            </Button>
            <Button
              variant="outline"
              onClick={() => handleSaveOgImage(true)}
              disabled={isSavingOgImage || !(drive.publishDefaultOgImageUrl ?? '')}
            >
              Clear
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
