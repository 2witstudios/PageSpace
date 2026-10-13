'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, useRouter } from '@/retained-adapters/navigation';
import { Button } from '@/retained/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/retained/components/ui/avatar';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/retained/components/ui/alert-dialog';
import { PermissionsGrid, type PageNode, type PermissionsGridRef } from '@/retained/components/members/PermissionsGrid';
import {
  changedPages,
  describeChanges,
  pageTitlesOf,
  type PagePermissions,
} from '@/retained/components/members/member-permission-changes';
import { RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Skeleton } from '@/retained/components/ui/skeleton';
import { Label } from '@/retained/components/ui/label';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/retained/components/ui/select';
import { patch, del, fetchWithAuth } from '@/retained/lib/auth/auth-fetch';
import { getRoleColorClasses } from '@/retained/lib/utils';
import { useEditingStore } from '@/retained/stores/useEditingStore';

interface MemberDetails {
  id: string;
  userId: string;
  role: string;
  customRoleId?: string | null;
  invitedAt: string;
  acceptedAt?: string;
  user: {
    id: string;
    email: string;
    name?: string;
  };
  profile?: {
    username?: string;
    displayName?: string;
    avatarUrl?: string;
  };
  drive: {
    id: string;
    name: string;
    slug: string;
    ownerId: string;
  };
}

interface CustomRole {
  id: string;
  name: string;
  description?: string;
  color?: string;
  isDefault: boolean;
  permissions: Record<string, PagePermissions>;
}

// Unified role type: Admin or a custom role
type UnifiedRole = { type: 'admin' } | { type: 'custom'; roleId: string } | null;

const unifiedRolesEqual = (a: UnifiedRole, b: UnifiedRole): boolean => {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (a.type !== b.type) return false;
  if (a.type === 'admin') return true;
  if (a.type === 'custom' && b.type === 'custom') return a.roleId === b.roleId;
  return false;
};

const shortDate = (value: string) => new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/** The member's line under the name: email · @username · invited … · joined … (C-Members-Profile). */
const memberLine = (member: MemberDetails): string =>
  [
    member.user.email,
    member.profile?.username ? `@${member.profile.username}` : null,
    `invited ${shortDate(member.invitedAt)}`,
    member.acceptedAt ? `joined ${shortDate(member.acceptedAt)}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');

/**
 * One member's access to the drive: the role, and the page permissions under it. Edits stay
 * local until Save changes (PATCH members/[userId]); the dirty bar names what would change.
 */
export default function MemberSettingsPage() {
  const params = useParams();
  const router = useRouter();
  const driveId = params.driveId as string;
  const userId = params.userId as string;

  const [member, setMember] = useState<MemberDetails | null>(null);
  const [customRoles, setCustomRoles] = useState<CustomRole[]>([]);
  const [selectedUnifiedRole, setSelectedUnifiedRole] = useState<UnifiedRole>(null);
  const [originalUnifiedRole, setOriginalUnifiedRole] = useState<UnifiedRole>(null);
  const [permissions, setPermissions] = useState<Map<string, PagePermissions>>(new Map());
  const [originalPermissions, setOriginalPermissions] = useState<Map<string, PagePermissions>>(new Map());
  const [pageTitles, setPageTitles] = useState<ReadonlyMap<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const startEditing = useEditingStore((state) => state.startEditing);
  const endEditing = useEditingStore((state) => state.endEditing);
  const permissionsGridRef = useRef<PermissionsGridRef>(null);

  const isOwner = member?.userId === member?.drive.ownerId;
  const isAdmin = selectedUnifiedRole?.type === 'admin';
  const roleChanged = !unifiedRolesEqual(selectedUnifiedRole, originalUnifiedRole);
  const pageChanges = useMemo(
    () => changedPages(originalPermissions, permissions, pageTitles),
    [originalPermissions, permissions, pageTitles],
  );
  const hasChanges = pageChanges.length > 0 || roleChanged;

  // A dirty member profile holds the editing store, so an auth refresh or SWR revalidation waits for the save.
  useEffect(() => {
    if (!hasChanges) return;
    const sessionId = `member-permissions:${userId}`;
    startEditing(sessionId, 'form', { componentName: 'MemberSettingsPage' });
    return () => endEditing(sessionId);
  }, [hasChanges, userId, startEditing, endEditing]);

  useEffect(() => {
    void fetchMemberDetails();
    void fetchRoles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driveId, userId]);

  const fetchRoles = async () => {
    try {
      const response = await fetchWithAuth(`/api/drives/${driveId}/roles`);
      if (response.ok) {
        const data = await response.json();
        setCustomRoles(data.roles || []);
      }
    } catch (error) {
      console.error('Error fetching roles:', error);
    }
  };

  const fetchMemberDetails = async () => {
    try {
      const response = await fetchWithAuth(`/api/drives/${driveId}/members/${userId}`);
      if (!response.ok) {
        if (response.status === 403) {
          toast.error('Only drive owners and admins can manage member settings');
          router.push(`/dashboard/${driveId}/members`);
          return;
        }
        throw new Error('Failed to fetch member details');
      }
      const data = await response.json();
      setMember(data.member);

      let unifiedRole: UnifiedRole = null;
      if (data.member.role === 'ADMIN') {
        unifiedRole = { type: 'admin' };
      } else if (data.member.customRoleId) {
        unifiedRole = { type: 'custom', roleId: data.member.customRoleId };
      }
      setSelectedUnifiedRole(unifiedRole);
      setOriginalUnifiedRole(unifiedRole);

      if (data.permissions) {
        const permsMap = new Map<string, PagePermissions>();
        data.permissions.forEach((perm: { pageId: string; canView: boolean; canEdit: boolean; canShare: boolean }) => {
          permsMap.set(perm.pageId, {
            canView: perm.canView,
            canEdit: perm.canEdit,
            canShare: perm.canShare,
          });
        });
        setPermissions(permsMap);
        setOriginalPermissions(new Map(permsMap));
      }
    } catch (error) {
      console.error('Error fetching member details:', error);
      toast.error('Failed to load member details');
    } finally {
      setLoading(false);
    }
  };

  // Unified role change handler
  const handleUnifiedRoleChange = (value: string) => {
    if (value === 'admin') {
      setSelectedUnifiedRole({ type: 'admin' });
      setPermissions(new Map()); // Admin has full access; no page rows apply
    } else if (value === 'none') {
      setSelectedUnifiedRole(null);
    } else {
      setSelectedUnifiedRole({ type: 'custom', roleId: value });
      // Changing the role re-applies its page permissions to the grid
      const role = customRoles.find((r) => r.id === value);
      if (role && permissionsGridRef.current) {
        permissionsGridRef.current.applyRolePermissions(role.permissions);
      }
    }
  };

  const handleSyncToRole = () => {
    if (selectedUnifiedRole?.type === 'custom') {
      const role = customRoles.find((r) => r.id === selectedUnifiedRole.roleId);
      if (role && permissionsGridRef.current) {
        permissionsGridRef.current.applyRolePermissions(role.permissions);
        toast.success(`Permissions reset to "${role.name}" defaults`);
      }
    }
  };

  const handlePermissionChange = (pageId: string, perms: PagePermissions) => {
    setPermissions((prevPermissions) => {
      const newPermissions = new Map(prevPermissions);
      newPermissions.set(pageId, perms);
      return newPermissions;
    });
  };

  const handleTreeLoaded = (pages: readonly PageNode[]) => setPageTitles(pageTitlesOf(pages));

  const handleDiscard = () => {
    setPermissions(new Map(originalPermissions));
    setSelectedUnifiedRole(originalUnifiedRole);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const backendRole = selectedUnifiedRole?.type === 'admin' ? 'ADMIN' : 'MEMBER';
      const backendCustomRoleId = selectedUnifiedRole?.type === 'custom' ? selectedUnifiedRole.roleId : null;

      const permissionsArray = Array.from(permissions.entries()).map(([pageId, perms]) => ({
        pageId,
        ...perms,
      }));

      await patch(`/api/drives/${driveId}/members/${userId}`, {
        role: backendRole,
        customRoleId: backendCustomRoleId,
        permissions: permissionsArray,
      });

      toast.success('Member settings updated successfully');
      setOriginalPermissions(new Map(permissions));
      setOriginalUnifiedRole(selectedUnifiedRole);
    } catch (error) {
      console.error('Error saving changes:', error);
      toast.error('Failed to save changes');
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    try {
      await del(`/api/drives/${driveId}/members/${userId}`);
      toast.success('Member removed');
      router.push(`/dashboard/${driveId}/members`);
    } catch (error) {
      console.error('Error removing member:', error);
      toast.error('Failed to remove member');
    }
  };

  if (loading) {
    return (
      <div className="h-full overflow-auto p-6">
        <Skeleton className="mb-6 h-8 w-48" />
        <Skeleton className="mb-6 h-32 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (!member) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-muted-foreground">Member not found</p>
      </div>
    );
  }

  const displayName = member.profile?.displayName || member.user.name || 'Unknown User';
  const initials = displayName
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
  const selectedRoleName =
    selectedUnifiedRole?.type === 'admin'
      ? 'Admin'
      : selectedUnifiedRole?.type === 'custom'
        ? (customRoles.find((r) => r.id === selectedUnifiedRole.roleId)?.name ?? 'custom role')
        : 'No role';
  const summary = pageChanges.length > 0 ? describeChanges(pageChanges) : `Role changed to ${selectedRoleName}`;

  return (
    <div className="relative flex h-full flex-col overflow-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-6 pb-24">
        <header className="flex items-start gap-4">
          <Avatar className="size-12">
            <AvatarImage src={member.profile?.avatarUrl} alt={displayName} />
            <AvatarFallback>{initials}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-bold tracking-tight">{displayName}</h1>
            <p className="text-sm text-muted-foreground">{memberLine(member)}</p>
          </div>
          {!isOwner && (
            <Button variant="outline" size="sm" className="text-destructive" onClick={() => setRemoveOpen(true)}>
              Remove from drive
            </Button>
          )}
        </header>

        {isOwner ? (
          <p className="text-sm text-muted-foreground">Drive owners have full access to all pages by default.</p>
        ) : (
          <section className="flex flex-col gap-2">
            <Label htmlFor="unified-role-select">Role</Label>
            <Select
              value={
                selectedUnifiedRole?.type === 'admin'
                  ? 'admin'
                  : selectedUnifiedRole?.type === 'custom'
                    ? selectedUnifiedRole.roleId
                    : 'none'
              }
              onValueChange={handleUnifiedRoleChange}
            >
              <SelectTrigger id="unified-role-select" className="max-w-md">
                <SelectValue placeholder="Select a role" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">
                  <span className="text-sm">Admin — full access</span>
                </SelectItem>

                {customRoles.length > 0 && <SelectSeparator />}

                {customRoles.map((role) => (
                  <SelectItem key={role.id} value={role.id}>
                    <span className={`rounded px-1.5 py-0.5 text-xs ${getRoleColorClasses(role.color)}`}>{role.name}</span>
                  </SelectItem>
                ))}

                {customRoles.length === 0 && <SelectSeparator />}

                <SelectItem value="none">
                  <span className="text-muted-foreground">No role (custom permissions)</span>
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {isAdmin
                ? 'Admins have full access to all pages, just like the drive owner.'
                : 'Changing the role re-applies its page permissions below.'}
            </p>
          </section>
        )}

        {!isOwner && isAdmin && (
          <p className="text-sm text-muted-foreground">No permission configuration needed.</p>
        )}

        {!isOwner && !isAdmin && (
          <section className="flex flex-col gap-3">
            <div className="flex items-end justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Page permissions</h2>
                <p className="text-sm text-muted-foreground">Edit and Share imply View. Turning off View removes all three.</p>
              </div>
              {selectedUnifiedRole?.type === 'custom' && (
                <Button variant="outline" size="sm" onClick={handleSyncToRole} title="Reset permissions to role defaults">
                  <RefreshCw className="mr-2 size-4" />
                  Sync to role
                </Button>
              )}
            </div>
            <PermissionsGrid
              ref={permissionsGridRef}
              driveId={driveId}
              userId={userId}
              permissions={permissions}
              onChange={handlePermissionChange}
              onTreeLoaded={handleTreeLoaded}
              readOnlyDriveRoot
            />
          </section>
        )}
      </div>

      {hasChanges && (
        <div
          role="region"
          aria-label="Unsaved changes"
          className="sticky bottom-0 flex items-center gap-3 border-t border-border bg-background px-6 py-3 shadow-sm"
        >
          <span className="min-w-0 flex-1 truncate text-sm">{summary}</span>
          <Button variant="ghost" onClick={handleDiscard} disabled={saving}>
            Discard
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      )}

      <AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {displayName} from this drive?</AlertDialogTitle>
            <AlertDialogDescription>They lose access to this drive.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleRemove}>Remove from drive</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
