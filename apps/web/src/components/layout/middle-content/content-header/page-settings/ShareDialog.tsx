'use client';

import { useState } from 'react';
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
import { Button } from '@/components/ui/button';
import { Users, UserCog, Lock, Share2 } from 'lucide-react';
import { useMobile } from '@/hooks/useMobile';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PermissionsList } from './PermissionsList';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { post, fetchWithAuth } from '@/lib/auth/auth-fetch';
import { PageShareLinkSection } from './PageShareLinkSection';

export function ShareDialog({ pageId: propPageId }: { pageId?: string | null } = {}) {
  const storePageId = usePageStore((state) => state.pageId);
  const pageId = propPageId !== undefined ? propPageId : storePageId;
  const params = useParams();
  const driveId = params.driveId as string;
  const { tree } = usePageTree(driveId);
  const pageResult = pageId ? findNodeAndParent(tree, pageId) : null;
  const page = pageResult?.node;
  const [isOpen, setIsOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [offPlatformEmail, setOffPlatformEmail] = useState<string | null>(null);
  const [expiryDays, setExpiryDays] = useState<number | null>(null);
  const [permissions, setPermissions] = useState({
    canView: true,
    canEdit: false,
    canShare: false,
    canDelete: false,
  });
  // Add a key to force re-render of PermissionsList
  const [permissionsVersion, setPermissionsVersion] = useState(0);

  // Check user permissions
  const { permissions: userPermissions } = usePermissions(pageId);
  const canShare = userPermissions?.canShare || false;
  const isMobile = useMobile();

  if (!page) return null;

  const handlePermissionChange = (permission: string, checked: boolean) => {
    const newPerms = { ...permissions };

    if (permission === 'canView' && !checked) {
      // If removing view, remove all other permissions
      newPerms.canView = false;
      newPerms.canEdit = false;
      newPerms.canShare = false;
      newPerms.canDelete = false;
    } else if ((permission === 'canEdit' || permission === 'canShare' || permission === 'canDelete') && checked) {
      // If granting edit/share/delete, must have view
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
      // 1. Find the user by email
      const userResponse = await fetchWithAuth(`/api/users/find?email=${encodeURIComponent(email)}`);
      if (!userResponse.ok) {
        if (userResponse.status === 404) {
          // User not found — switch to off-platform invite mode
          setOffPlatformEmail(email);
          return;
        }
        const { error } = await userResponse.json();
        throw new Error(error || 'User not found.');
      }
      const user = await userResponse.json();

      // 2. Create the permission with checkbox values
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
      // Translate checkbox state → VIEW/EDIT/SHARE array (DELETE excluded for off-platform)
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

  // Show button but disable if no share permission
  if (!canShare) {
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
      <DialogTrigger asChild>
        <Button variant="ghost" size={isMobile ? "icon" : "sm"}>
          <Share2 className={isMobile ? "h-4 w-4" : "mr-2 h-4 w-4"} />
          {!isMobile && "Share"}
        </Button>
      </DialogTrigger>
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
          <Tabs defaultValue="share" className="mt-4">
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
                <PageShareLinkSection pageId={page.id} />
              </div>
            </TabsContent>
            <TabsContent value="permissions" className="mt-4">
              <PermissionsList key={permissionsVersion} />
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}
