'use client';

import { useState, useEffect, useMemo } from 'react';
import { useParams, useRouter } from '@/retained-adapters/navigation';
import { Button } from '@/retained/components/ui/button';
import { Input } from '@/retained/components/ui/input';
import { Label } from '@/retained/components/ui/label';
import { Avatar, AvatarFallback, AvatarImage } from '@/retained/components/ui/avatar';
import { Skeleton } from '@/retained/components/ui/skeleton';
import { Shield, Loader2, Home } from 'lucide-react';
import Link from '@/retained-adapters/link';
import { useDriveStore } from '@/retained/hooks/useDrive';
import type { TreePage } from '@/retained/hooks/usePageTree';
import { usePageTree } from '@/retained/hooks/usePageTree';
import { findNodeAndParent } from '@/retained/lib/tree/tree-utils';
import { useEditingStore } from '@/retained/stores/useEditingStore';
import { PagePickerPopover } from '@/retained/components/common/PagePickerPopover';
import { toast } from 'sonner';
import { fetchWithAuth, patch } from '@/retained/lib/auth/auth-fetch';
import { homeDriveActionError } from '@pagespace/lib/services/drive-guards';
import useSWR from 'swr';
import { SettingsGroup, SettingsRow, SettingsScreen, SettingsSection } from '@/ui/settings/settings-screen/settings-screen';
import { ImagoAccessSection } from '@/ui/settings/imago-access/imago-access-section';

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

const fetcher = (url: string) => fetchWithAuth(url).then((r) => r.json());

/** The page's title path from the root down to it, as the sidebar tree nests it ("Launch / Q4 Launch Plan"). */
const titlePath = (tree: TreePage[], pageId: string): string[] => {
  const found = findNodeAndParent(tree, pageId);
  if (!found) return [];
  const ancestors: string[] = [];
  let parent = found.parent;
  while (parent) {
    ancestors.unshift(parent.title ?? 'Untitled');
    const up = findNodeAndParent(tree, parent.id);
    parent = up?.parent ?? null;
  }
  return [...ancestors, found.node.title ?? 'Untitled'];
};

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
  // A Home drive cannot be renamed: its guard's words stand where the field would be.
  const renameRefusal = drive ? homeDriveActionError(drive, 'rename') : null;

  useEffect(() => {
    if (drive && !useEditingStore.getState().isAnyEditing()) setName(drive.name);
  }, [drive]);

  const { data: membersData } = useSWR<MembersResponse>(
    drive ? `/api/drives/${driveId}/members` : null,
    fetcher
  );
  const { data: agentMembersData } = useSWR<AgentMembersResponse>(
    drive ? `/api/drives/${driveId}/agents/members` : null,
    fetcher
  );

  const homePageId = drive?.homePageId ?? null;
  // Memoized: the controlled name input re-renders this page per keystroke,
  // and the title path is a full tree walk.
  const homePathTitles = useMemo(
    () => (homePageId ? titlePath(tree, homePageId) : []),
    [tree, homePageId]
  );

  const handleSetHomePage = async (pageId: string | null) => {
    if (!pageId) return;
    try {
      await patch(`/api/drives/${driveId}`, { homePageId: pageId });
      updateDriveInStore(driveId, { homePageId: pageId });
      toast.success('Home page set');
    } catch {
      toast.error('Failed to set home page');
    }
  };

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
      <div className="mx-auto w-full max-w-2xl space-y-6 px-6 py-10">
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
  const topAvatars = (membersData?.members ?? []).slice(0, 5);
  const nameDirty = name.trim() !== '' && name.trim() !== drive.name;

  return (
    <SettingsScreen title="General" lede="Basic drive settings">
      <SettingsSection
        title="Drive name"
        description="Shown in the spine, in links and to everyone you invite."
      >
        <SettingsGroup>
          <div className="flex flex-col gap-2 px-4 py-3">
            <Label htmlFor="drive-name">Name</Label>
            <div className="flex items-center gap-2">
              <Input
                id="drive-name"
                value={name}
                disabled={renameRefusal !== null}
                onChange={(e) => setName(e.target.value)}
                onFocus={() => startEditing('drive-settings-rename', 'form', { componentName: 'GeneralSettingsPage' })}
                onBlur={() => endEditing('drive-settings-rename')}
                onKeyDown={(e) => e.key === 'Enter' && handleSave()}
                placeholder="Drive name"
              />
              <Button onClick={handleSave} disabled={isSaving || renameRefusal !== null || !nameDirty}>
                {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Save
              </Button>
            </div>
            {renameRefusal === null ? (
              <span className="text-xs text-muted-foreground">
                Slug <code>{drive.slug}</code> stays the same when you rename.
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">{renameRefusal}</span>
            )}
          </div>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="Home page"
        description="The page people land on when they enter this drive."
      >
        <SettingsGroup>
          {homePageId ? (
            <SettingsRow
              label={
                <span className="flex items-center gap-2">
                  <Home className="h-4 w-4 flex-none text-muted-foreground" />
                  <Link href={`/dashboard/${driveId}/${homePageId}`} className="truncate hover:underline">
                    {homePathTitles[homePathTitles.length - 1] ?? 'Unknown page'}
                  </Link>
                </span>
              }
              hint={homePathTitles.length > 1 ? homePathTitles.join(' / ') : undefined}
            >
              <div className="w-56">
                <PagePickerPopover driveId={driveId} value={null} onChange={handleSetHomePage} placeholder="Change" />
              </div>
              <Button variant="outline" size="sm" onClick={handleClearHomePage} disabled={isClearingHomePage}>
                {isClearingHomePage && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Clear
              </Button>
            </SettingsRow>
          ) : (
            <SettingsRow label="No home page" hint="Right-click a page in the sidebar to set one">
              <div className="w-56">
                <PagePickerPopover driveId={driveId} value={null} onChange={handleSetHomePage} placeholder="Choose a page" />
              </div>
            </SettingsRow>
          )}
        </SettingsGroup>
      </SettingsSection>

      <ImagoAccessSection driveId={driveId} />

      <SettingsSection
        title="Members overview"
        description="Current members of this drive."
        actions={
          <Link href={`/dashboard/${driveId}/members`} className="text-sm font-medium text-accent">
            Manage members →
          </Link>
        }
      >
        <SettingsGroup>
          <div className="flex flex-col gap-3 px-4 py-3">
            <div className="flex gap-6 text-sm">
              <span>
                <span className="font-semibold">{humanCount}</span> {humanCount === 1 ? 'person' : 'people'}
              </span>
              <span>
                <span className="font-semibold">{agentCount}</span> {agentCount === 1 ? 'agent' : 'agents'}
              </span>
            </div>
            {topAvatars.length > 0 && (
              <div className="flex -space-x-2">
                {topAvatars.map((m) => (
                  <Avatar key={m.id} className="h-8 w-8 border-2 border-background">
                    <AvatarImage src={m.profile?.avatar ?? undefined} alt={m.user.name ?? m.user.email} />
                    <AvatarFallback className="text-xs">
                      {(m.user.name ?? m.user.email).slice(0, 2).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                ))}
              </div>
            )}
          </div>
        </SettingsGroup>
      </SettingsSection>
    </SettingsScreen>
  );
}
