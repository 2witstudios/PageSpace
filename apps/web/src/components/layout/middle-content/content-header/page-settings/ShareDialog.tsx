'use client';

import { useState } from 'react';
import { usePageStore } from '@/hooks/usePage';
import { usePageTree } from '@/hooks/usePageTree';
import { findNodeAndParent } from '@/lib/tree/tree-utils';
import { useParams } from 'next/navigation';
import { usePermissions, getPermissionErrorMessage } from '@/hooks/use-permissions';
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
import { ArrowUpLeftFromSquare, Users, UserCog, Lock } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { PermissionsList } from './PermissionsList';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';

export function ShareDialog() {
  const pageId = usePageStore((state) => state.pageId);
  const params = useParams();
  const driveId = params.driveId as string;
  const { tree } = usePageTree(driveId);
  const pageResult = pageId ? findNodeAndParent(tree, pageId) : null;
  const page = pageResult?.node;
  const [isOpen, setIsOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
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

  const handleInvite = async () => {
    if (!email) {
      toast.error('Please enter an email address.');
      return;
    }
    setIsSubmitting(true);
    try {
      // 1. Find the user by email
      const userResponse = await fetch(`/api/users/find?email=${encodeURIComponent(email)}`);
      if (!userResponse.ok) {
        const { error } = await userResponse.json();
        throw new Error(error || 'User not found.');
      }
      const user = await userResponse.json();

      // 2. Create the permission with checkbox values
      const permissionResponse = await fetch(`/api/pages/${page.id}/permissions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: user.id,
          ...permissions,
        }),
      });

      if (!permissionResponse.ok) {
        const { error } = await permissionResponse.json();
        throw new Error(error || 'Failed to grant permission.');
      }

      toast.success(`Permission granted to ${email}`);
      setEmail('');
      // Reset permissions to default
      setPermissions({
        canView: true,
        canEdit: false,
        canShare: false,
        canDelete: false,
      });
      // Increment version to trigger re-render of PermissionsList
      setPermissionsVersion(v => v + 1);
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
            <Button variant="ghost" size="sm" disabled className="opacity-50 cursor-not-allowed">
              <Lock className="mr-2 h-4 w-4" />
              Share
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
        <Button variant="ghost" size="sm">
          <ArrowUpLeftFromSquare className="mr-2 h-4 w-4" />
          Share
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
            <div className="flex space-x-2">
              <Input
                type="email"
                placeholder="Add people by email..."
                className="flex-1"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={isSubmitting || !canShare}
              />
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
              </div>
            </div>
            
            <Button onClick={handleInvite} disabled={isSubmitting} className="w-full">
              {isSubmitting ? 'Granting Access...' : 'Grant Access'}
            </Button>
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