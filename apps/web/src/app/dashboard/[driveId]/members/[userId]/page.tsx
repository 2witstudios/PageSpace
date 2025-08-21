'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { PermissionsGrid } from '@/components/members/PermissionsGrid';
import { ChevronLeft, Save, X, Shield } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { Skeleton } from '@/components/ui/skeleton';

interface MemberDetails {
  id: string;
  userId: string;
  role: string;
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

export default function MemberSettingsPage() {
  const params = useParams();
  const router = useRouter();
  const { toast } = useToast();
  const driveId = params.driveId as string;
  const userId = params.userId as string;

  const [member, setMember] = useState<MemberDetails | null>(null);
  const [permissions, setPermissions] = useState<Map<string, { canView: boolean; canEdit: boolean; canShare: boolean }>>(new Map());
  const [originalPermissions, setOriginalPermissions] = useState<Map<string, { canView: boolean; canEdit: boolean; canShare: boolean }>>(new Map());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    fetchMemberDetails();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driveId, userId]);

  useEffect(() => {
    // Check if permissions have changed
    if (originalPermissions.size > 0) {
      const changed = Array.from(permissions.entries()).some(([pageId, perms]) => {
        const original = originalPermissions.get(pageId);
        if (!original) return true;
        return original.canView !== perms.canView || 
               original.canEdit !== perms.canEdit || 
               original.canShare !== perms.canShare;
      });
      setHasChanges(changed);
    }
  }, [permissions, originalPermissions]);

  const fetchMemberDetails = async () => {
    try {
      const response = await fetch(`/api/drives/${driveId}/members/${userId}`, {
        credentials: 'include',
      });
      if (!response.ok) {
        if (response.status === 403) {
          toast({
            title: 'Access Denied',
            description: 'Only drive owners can manage member settings',
            variant: 'destructive',
          });
          router.push(`/dashboard/${driveId}/members`);
          return;
        }
        throw new Error('Failed to fetch member details');
      }
      const data = await response.json();
      setMember(data.member);
      
      // Initialize permissions map
      if (data.permissions) {
        const permsMap = new Map();
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
      toast({
        title: 'Error',
        description: 'Failed to load member details',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  const handlePermissionChange = (pageId: string, perms: { canView: boolean; canEdit: boolean; canShare: boolean }) => {
    const newPermissions = new Map(permissions);
    newPermissions.set(pageId, perms);
    setPermissions(newPermissions);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const permissionsArray = Array.from(permissions.entries()).map(([pageId, perms]) => ({
        pageId,
        ...perms
      }));

      const response = await fetch(`/api/drives/${driveId}/members/${userId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ permissions: permissionsArray }),
      });

      if (!response.ok) throw new Error('Failed to save permissions');

      toast({
        title: 'Success',
        description: 'Permissions updated successfully',
      });
      
      setOriginalPermissions(new Map(permissions));
      setHasChanges(false);
    } catch (error) {
      console.error('Error saving permissions:', error);
      toast({
        title: 'Error',
        description: 'Failed to save permissions',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setPermissions(new Map(originalPermissions));
    setHasChanges(false);
  };

  if (loading) {
    return (
      <div className="h-full overflow-auto">
        <div className="max-w-6xl mx-auto p-6">
          <Skeleton className="h-8 w-48 mb-6" />
          <Skeleton className="h-32 w-full mb-6" />
          <Skeleton className="h-96 w-full" />
        </div>
      </div>
    );
  }

  if (!member) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-gray-500 dark:text-gray-400">Member not found</p>
      </div>
    );
  }

  const displayName = member.profile?.displayName || member.user.name || 'Unknown User';
  const initials = displayName
    .split(' ')
    .map(n => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  const getRoleBadgeColor = (role: string) => {
    switch (role) {
      case 'OWNER':
        return 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300';
      case 'ADMIN':
        return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300';
      default:
        return 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300';
    }
  };

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-6xl mx-auto p-6">
        {/* Header with back button */}
        <div className="mb-6">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push(`/dashboard/${driveId}/members`)}
            className="mb-4"
          >
            <ChevronLeft className="w-4 h-4 mr-1" />
            Back to Members
          </Button>
          
          <h1 className="text-2xl font-bold">Member Settings</h1>
          <p className="text-gray-600 dark:text-gray-400 mt-1">
            Manage permissions for {displayName} in {member.drive.name}
          </p>
        </div>

        {/* Member Info Card */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Member Information</CardTitle>
            <CardDescription>Details about this member</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-start space-x-4">
              <Avatar className="w-16 h-16">
                <AvatarImage src={member.profile?.avatarUrl} alt={displayName} />
                <AvatarFallback>{initials}</AvatarFallback>
              </Avatar>
              
              <div className="flex-1">
                <div className="flex items-center space-x-2 mb-2">
                  <h3 className="text-lg font-semibold">{displayName}</h3>
                  {member.profile?.username && (
                    <span className="text-sm text-gray-500 dark:text-gray-400">
                      @{member.profile.username}
                    </span>
                  )}
                  <Badge className={getRoleBadgeColor(member.role)}>
                    {member.role}
                  </Badge>
                </div>
                
                <p className="text-sm text-gray-600 dark:text-gray-400 mb-1">
                  {member.user.email}
                </p>
                
                <div className="flex gap-4 text-xs text-gray-500 dark:text-gray-400">
                  <span>Invited: {new Date(member.invitedAt).toLocaleDateString()}</span>
                  {member.acceptedAt && (
                    <span>Joined: {new Date(member.acceptedAt).toLocaleDateString()}</span>
                  )}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Permissions Card */}
        <Card>
          <CardHeader>
            <CardTitle>Page Permissions</CardTitle>
            <CardDescription>
              {member.userId === member.drive.ownerId 
                ? 'Drive owner permissions'
                : 'Control which pages this member can view, edit, or share'
              }
            </CardDescription>
          </CardHeader>
          <CardContent>
            {member.userId === member.drive.ownerId ? (
              <div className="py-8 text-center">
                <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-purple-100 dark:bg-purple-900/30 mb-4">
                  <Shield className="w-8 h-8 text-purple-600 dark:text-purple-400" />
                </div>
                <h3 className="text-lg font-semibold mb-2">Owner Access</h3>
                <p className="text-gray-600 dark:text-gray-400">
                  Drive owners have full access to all pages by default.
                </p>
                <p className="text-sm text-gray-500 dark:text-gray-500 mt-2">
                  No permission configuration needed.
                </p>
              </div>
            ) : (
              <>
                <PermissionsGrid
                  driveId={driveId}
                  userId={userId}
                  permissions={permissions}
                  onChange={handlePermissionChange}
                />
                
                {/* Action Buttons */}
                <div className="flex justify-end gap-2 mt-6">
                  <Button
                    variant="outline"
                    onClick={handleCancel}
                    disabled={!hasChanges || saving}
                  >
                    <X className="w-4 h-4 mr-2" />
                    Cancel
                  </Button>
                  <Button
                    onClick={handleSave}
                    disabled={!hasChanges || saving}
                  >
                    <Save className="w-4 h-4 mr-2" />
                    {saving ? 'Saving...' : 'Save Changes'}
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}