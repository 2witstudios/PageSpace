'use client';

import { useState, useEffect } from 'react';
import { usePageStore } from '@/hooks/usePage';
import { usePageTree } from '@/hooks/usePageTree';
import { findNodeAndParent } from '@/lib/tree/tree-utils';
import { useParams } from 'next/navigation';
import { usePermissions, getPermissionErrorMessage } from '@/hooks/usePermissions';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Users, UserCog, Lock, Share2 } from 'lucide-react';
import { useMobile } from '@/hooks/useMobile';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { PermissionsList } from './PermissionsList';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { post, put, fetchWithAuth, patch } from '@/lib/auth/auth-fetch';
import { PageShareLinkSection } from './PageShareLinkSection';
import type { DriveRole } from '@pagespace/lib/services/drive-role-service';
import type { RoleGrant } from '@/services/api';

interface ShareDialogProps {
  pageId?: string | null;
  defaultTab?: 'share' | 'permissions';
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function ShareDialog({
  pageId: propPageId,
  defaultTab = 'share',
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
}: ShareDialogProps = {}) {
  const storePageId = usePageStore((state) => state.pageId);
  const pageId = propPageId !== undefined ? propPageId : storePageId;
  const params = useParams();
  const driveId = params.driveId as string;
  const { tree } = usePageTree(driveId);
  const pageResult = pageId ? findNodeAndParent(tree, pageId) : null;
  const page = pageResult?.node;

  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen! : internalOpen;
  const setIsOpen = isControlled ? controlledOnOpenChange! : setInternalOpen;

  const [email, setEmail] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isPrivate, setIsPrivate] = useState(false);
  const [isTogglingPrivacy, setIsTogglingPrivacy] = useState(false);

  useEffect(() => {
    if (page) setIsPrivate(!!page.isPrivate);
  }, [page]);

  const [offPlatformEmail, setOffPlatformEmail] = useState<string | null>(null);
  const [expiryDays, setExpiryDays] = useState<number | null>(null);
  const [permissions, setPermissions] = useState({
    canView: true,
    canEdit: false,
    canShare: false,
    canDelete: false,
  });
  const [permissionsVersion, setPermissionsVersion] = useState(0);

  // Role granting state
  const [driveRoles, setDriveRoles] = useState<DriveRole[]>([]);
  const [grantedRoles, setGrantedRoles] = useState<RoleGrant[]>([]);
  const [selectedRoleId, setSelectedRoleId] = useState<string>('');
  const [rolePermissions, setRolePermissions] = useState({ canView: true, canEdit: false, canShare: false });
  const [isAddingRole, setIsAddingRole] = useState(false);

  const { permissions: userPermissions } = usePermissions(pageId);
  const canShare = userPermissions?.canShare || false;
  const isMobile = useMobile();

  // Fetch drive roles and current role grants when dialog opens
  useEffect(() => {
    if (!isOpen || !pageId || !driveId) return;

    const fetchRoleData = async () => {
      const [rolesRes, grantsRes] = await Promise.all([
        fetchWithAuth(`/api/drives/${driveId}/roles`),
        fetchWithAuth(`/api/pages/${pageId}/role-permissions`),
      ]);
      if (rolesRes.ok) {
        const { roles } = await rolesRes.json() as { roles: DriveRole[] };
        setDriveRoles(roles);
      }
      if (grantsRes.ok) {
        const { roles } = await grantsRes.json() as { roles: RoleGrant[] };
        setGrantedRoles(roles);
      }
    };

    fetchRoleData();
  }, [isOpen, pageId, driveId]);

  if (!page) return null;

  const handlePrivacyToggle = async (newValue: boolean) => {
    setIsPrivate(newValue);
    setIsTogglingPrivacy(true);
    try {
      await patch(`/api/pages/${page.id}`, { isPrivate: newValue });
      toast.success(newValue ? 'Page is now private' : 'Page is now visible to all drive members');
    } catch {
      setIsPrivate(!newValue);
      toast.error('Failed to update page visibility');
    } finally {
      setIsTogglingPrivacy(false);
    }
  };

  const handlePermissionChange = (permission: string, checked: boolean) => {
    const newPerms = { ...permissions };

    if (permission === 'canView' && !checked) {
      newPerms.canView = false;
      newPerms.canEdit = false;
      newPerms.canShare = false;
      newPerms.canDelete = false;
    } else if ((permission === 'canEdit' || permission === 'canShare' || permission === 'canDelete') && checked) {
      newPerms.canView = true;
      newPerms[permission as keyof typeof permissions] = true;
    } else {
      newPerms[permission as keyof typeof permissions] = checked;
    }

    setPermissions(newPerms);
  };

  const resetForm = () => {
    setEmail('');
    setOffPlatformEmail(null);
    setExpiryDays(null);
    setPermissions({ canView: true, canEdit: false, canShare: false, canDelete: false });
    setPermissionsVersion(v => v + 1);
  };

  const handleInvite = async () => {
    if (!email) {
      toast.error('Please enter an email address.');
      return;
    }
    setIsSubmitting(true);
    try {
      const userResponse = await fetchWithAuth(`/api/users/find?email=${encodeURIComponent(email)}`);
      if (!userResponse.ok) {
        if (userResponse.status === 404) {
          setOffPlatformEmail(email);
          return;
        }
        const { error } = await userResponse.json();
        throw new Error(error || 'User not found.');
      }
      const user = await userResponse.json();

      await post(`/api/pages/${page.id}/permissions`, {
        userId: user.id,
        ...permissions,
      });

      toast.success(`Permission granted to ${email}`);
      resetForm();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred.';
      toast.error(errorMessage);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleOffPlatformInvite = async () => {
    if (!offPlatformEmail) return;
    setIsSubmitting(true);
    try {
      const permissionsArray: Array<'VIEW' | 'EDIT' | 'SHARE'> = ['VIEW'];
      if (permissions.canEdit) permissionsArray.push('EDIT');
      if (permissions.canShare) permissionsArray.push('SHARE');

      const response = await fetchWithAuth(`/api/pages/${page.id}/share-invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: offPlatformEmail,
          permissions: permissionsArray,
          ...(expiryDays !== null && { expiryDays }),
        }),
      });

      if (response.status === 409) {
        toast.info(`An invite is already pending for ${offPlatformEmail}`);
        resetForm();
        return;
      }

      const json = await response.json().catch(() => ({})) as { kind?: string; error?: string };
      if (!response.ok) {
        throw new Error(json.error || 'Failed to send invite.');
      }

      if (json.kind === 'granted') {
        toast.success(`Access granted to ${offPlatformEmail}`);
      } else {
        toast.success(`Invite sent to ${offPlatformEmail}`);
      }
      resetForm();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred.';
      toast.error(errorMessage);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleAddRole = async () => {
    if (!selectedRoleId || !pageId) return;
    setIsAddingRole(true);
    try {
      await put(`/api/pages/${pageId}/role-permissions`, {
        roleId: selectedRoleId,
        ...rolePermissions,
      });
      const role = driveRoles.find(r => r.id === selectedRoleId);
      if (role) {
        setGrantedRoles(prev => [
          ...prev.filter(r => r.roleId !== selectedRoleId),
          { roleId: role.id, name: role.name, color: role.color, ...rolePermissions },
        ]);
      }
      setSelectedRoleId('');
      setRolePermissions({ canView: true, canEdit: false, canShare: false });
      setPermissionsVersion(v => v + 1);
      toast.success('Role access granted.');
    } catch {
      toast.error('Failed to grant role access.');
    } finally {
      setIsAddingRole(false);
    }
  };

  const ungrantedRoles = driveRoles.filter(r => !grantedRoles.some(g => g.roleId === r.id));

  // Show disabled button when no share permission and not controlled (used as trigger)
  if (!canShare && !isControlled) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size={isMobile ? "icon" : "sm"} disabled className="opacity-50 cursor-not-allowed">
              <Lock className={isMobile ? "h-4 w-4" : "mr-2 h-4 w-4"} />
              {!isMobile && "Share"}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>{getPermissionErrorMessage('share')}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      {!isControlled && (
        <DialogTrigger asChild>
          <Button variant="ghost" size={isMobile ? "icon" : "sm"}>
            <Share2 className={isMobile ? "h-4 w-4" : "mr-2 h-4 w-4"} />
            {!isMobile && "Share"}
          </Button>
        </DialogTrigger>
      )}
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Share &ldquo;{page.title}&rdquo;</DialogTitle>
          <DialogDescription>
            Manage who has access to this page.
          </DialogDescription>
        </DialogHeader>
        {!canShare ? (
          <Alert className="mt-4">
            <Lock className="h-4 w-4" />
            <AlertDescription>
              {getPermissionErrorMessage('share')}. Contact the page owner to request share access.
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <div className="mt-4 flex items-center justify-between rounded-lg border p-4">
              <div>
                <p className="text-sm font-medium">Private page</p>
                <p className="text-xs text-muted-foreground">
                  {isPrivate
                    ? 'Only you and people you\'ve explicitly shared with can see this page'
                    : 'All drive members can read this page'}
                </p>
              </div>
              <Switch
                checked={isPrivate}
                onCheckedChange={handlePrivacyToggle}
                disabled={isTogglingPrivacy}
                aria-label="Toggle page privacy"
              />
            </div>
            <Tabs defaultValue={defaultTab} className="mt-4">
              <TabsList>
                <TabsTrigger value="share">
                  <Users className="mr-2 h-4 w-4" />
                  Share
                </TabsTrigger>
                <TabsTrigger value="permissions">
                  <UserCog className="mr-2 h-4 w-4" />
                  Permissions
                </TabsTrigger>
              </TabsList>
              <TabsContent value="share" className="mt-4 space-y-4">
                {/* Role access section */}
                {driveRoles.length > 0 && (
                  <div className="border rounded-lg p-4 space-y-3">
                    <h4 className="text-sm font-medium">Grant role access</h4>
                    <p className="text-xs text-muted-foreground">
                      All members with the selected role will gain access to this page.
                    </p>
                    <div className="flex items-center gap-2">
                      <Select
                        value={selectedRoleId}
                        onValueChange={setSelectedRoleId}
                        disabled={ungrantedRoles.length === 0}
                      >
                        <SelectTrigger className="flex-1">
                          <SelectValue placeholder={ungrantedRoles.length === 0 ? 'All roles have access' : 'Select a role...'} />
                        </SelectTrigger>
                        <SelectContent>
                          {ungrantedRoles.map(role => (
                            <SelectItem key={role.id} value={role.id}>
                              <span className="flex items-center gap-2">
                                {role.color && (
                                  <span
                                    className="inline-block h-2.5 w-2.5 rounded-full"
                                    style={{ backgroundColor: role.color }}
                                  />
                                )}
                                {role.name}
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {selectedRoleId && (
                      <div className="flex items-center gap-4 flex-wrap">
                        <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                          <Checkbox
                            checked={rolePermissions.canView}
                            onCheckedChange={(checked) => {
                              const v = !!checked;
                              setRolePermissions(p => ({
                                canView: v,
                                canEdit: v ? p.canEdit : false,
                                canShare: v ? p.canShare : false,
                              }));
                            }}
                          />
                          View
                        </label>
                        <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                          <Checkbox
                            checked={rolePermissions.canEdit}
                            disabled={!rolePermissions.canView}
                            onCheckedChange={(checked) =>
                              setRolePermissions(p => ({ ...p, canView: true, canEdit: !!checked }))
                            }
                          />
                          Edit
                        </label>
                        <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                          <Checkbox
                            checked={rolePermissions.canShare}
                            disabled={!rolePermissions.canView}
                            onCheckedChange={(checked) =>
                              setRolePermissions(p => ({ ...p, canView: true, canShare: !!checked }))
                            }
                          />
                          Share
                        </label>
                        <Button
                          size="sm"
                          onClick={handleAddRole}
                          disabled={isAddingRole || !selectedRoleId}
                        >
                          {isAddingRole ? 'Adding...' : 'Add Role'}
                        </Button>
                      </div>
                    )}
                  </div>
                )}

                {/* User invite section */}
                {offPlatformEmail ? (
                  <Alert>
                    <AlertDescription>
                      <strong>{offPlatformEmail}</strong> is not yet on PageSpace. They will receive an
                      email invitation to create an account and access this page.
                    </AlertDescription>
                  </Alert>
                ) : null}
                <div className="flex space-x-2">
                  <Input
                    type="email"
                    placeholder="Add people by email..."
                    className="flex-1"
                    value={offPlatformEmail ?? email}
                    onChange={(e) => {
                      if (offPlatformEmail) {
                        setOffPlatformEmail(null);
                      }
                      setEmail(e.target.value);
                    }}
                    disabled={isSubmitting || !canShare || !!offPlatformEmail}
                  />
                  {offPlatformEmail && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setOffPlatformEmail(null)}
                      disabled={isSubmitting}
                    >
                      Cancel
                    </Button>
                  )}
                </div>

                {/* Permission Checkboxes */}
                <div className="border rounded-lg p-4 space-y-3">
                  <h4 className="text-sm font-medium mb-2">Permissions</h4>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="canView"
                        checked={permissions.canView}
                        onCheckedChange={(checked) => handlePermissionChange('canView', !!checked)}
                      />
                      <Label htmlFor="canView" className="text-sm">
                        View
                        <span className="text-xs text-gray-500 block">Can view this page</span>
                      </Label>
                    </div>

                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="canEdit"
                        checked={permissions.canEdit}
                        disabled={!permissions.canView}
                        onCheckedChange={(checked) => handlePermissionChange('canEdit', !!checked)}
                      />
                      <Label htmlFor="canEdit" className="text-sm">
                        Edit
                        <span className="text-xs text-gray-500 block">Can edit content</span>
                      </Label>
                    </div>

                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="canShare"
                        checked={permissions.canShare}
                        disabled={!permissions.canView}
                        onCheckedChange={(checked) => handlePermissionChange('canShare', !!checked)}
                      />
                      <Label htmlFor="canShare" className="text-sm">
                        Share
                        <span className="text-xs text-gray-500 block">Can share with others</span>
                      </Label>
                    </div>

                    {offPlatformEmail ? (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className="flex items-center space-x-2 opacity-50">
                              <Checkbox id="canDelete" checked={false} disabled />
                              <Label htmlFor="canDelete" className="text-sm cursor-not-allowed">
                                Delete
                                <span className="text-xs text-gray-500 block">Can delete this page</span>
                              </Label>
                            </div>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>Delete cannot be granted to off-platform invites</p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    ) : (
                      <div className="flex items-center space-x-2">
                        <Checkbox
                          id="canDelete"
                          checked={permissions.canDelete}
                          disabled={!permissions.canView}
                          onCheckedChange={(checked) => handlePermissionChange('canDelete', !!checked)}
                        />
                        <Label htmlFor="canDelete" className="text-sm">
                          Delete
                          <span className="text-xs text-gray-500 block">Can delete this page</span>
                        </Label>
                      </div>
                    )}
                  </div>
                </div>

                {offPlatformEmail && (
                  <div className="flex items-center gap-3">
                    <Label className="text-sm text-muted-foreground whitespace-nowrap">Invite expires</Label>
                    <Select
                      value={expiryDays === null ? 'never' : String(expiryDays)}
                      onValueChange={(v) => setExpiryDays(v === 'never' ? null : Number(v))}
                    >
                      <SelectTrigger className="w-36">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="never">Never</SelectItem>
                        <SelectItem value="1">1 day</SelectItem>
                        <SelectItem value="7">7 days</SelectItem>
                        <SelectItem value="30">30 days</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {offPlatformEmail ? (
                  <Button onClick={handleOffPlatformInvite} disabled={isSubmitting} className="w-full">
                    {isSubmitting
                      ? 'Sending Invite...'
                      : `Invite ${offPlatformEmail} to PageSpace and share this page`}
                  </Button>
                ) : (
                  <Button onClick={handleInvite} disabled={isSubmitting} className="w-full">
                    {isSubmitting ? 'Granting Access...' : 'Grant Access'}
                  </Button>
                )}

                <div className="border-t pt-4">
                  <PageShareLinkSection
                    pageId={page.id}
                    permissions={{
                      canView: permissions.canView,
                      canEdit: permissions.canEdit,
                      canShare: permissions.canShare,
                      canDelete: offPlatformEmail ? false : permissions.canDelete,
                    }}
                  />
                </div>
              </TabsContent>
              <TabsContent value="permissions" className="mt-4">
                <PermissionsList key={permissionsVersion} />
              </TabsContent>
            </Tabs>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
