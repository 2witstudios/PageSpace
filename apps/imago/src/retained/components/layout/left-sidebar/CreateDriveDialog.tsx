"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "@/retained-adapters/navigation";
import { toast } from "sonner";
import { post } from '@/retained/lib/auth/auth-fetch';
import { Drive } from '@pagespace/lib/types';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/retained/components/ui/dialog";
import { Button } from "@/retained/components/ui/button";
import { Input } from "@/retained/components/ui/input";
import { Label } from "@/retained/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/retained/components/ui/select";
import { useDriveStore } from "@/retained/hooks/useDrive";
import { useMyOrganizations } from "@/retained/hooks/useMyOrganizations";
import { creatableOrgs, defaultDriveOwner, driveOrgContext } from "@/retained/lib/drives/drive-owner-choice";

interface CreateDriveDialogProps {
  isOpen: boolean;
  setIsOpen: (isOpen: boolean) => void;
  /** DRV-3: the org the dialog was opened for (an org header); otherwise the current drive's org is the context. */
  contextOrgId?: string | null;
}

const PERSONAL = "personal";

export default function CreateDriveDialog({ isOpen, setIsOpen, contextOrgId }: CreateDriveDialogProps) {
  const [driveName, setDriveName] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Use selective Zustand subscriptions to prevent unnecessary re-renders
  const addDrive = useDriveStore(state => state.addDrive);
  const setCurrentDrive = useDriveStore(state => state.setCurrentDrive);
  const fetchDrives = useDriveStore(state => state.fetchDrives);
  const drives = useDriveStore(state => state.drives);
  const currentDriveId = useDriveStore(state => state.currentDriveId);

  // DRV-3: Personal, or one of the person's orgs that lets them create drives. Someone with no such
  // org sees no owner choice at all (ORG-2: no org UI).
  const { organizations } = useMyOrganizations();
  const offered = useMemo(() => creatableOrgs(organizations), [organizations]);
  const contextOrg = driveOrgContext({ explicitOrgId: contextOrgId, currentDriveId, drives });
  const initialOwner = defaultDriveOwner(contextOrg, offered) ?? PERSONAL;
  const [owner, setOwner] = useState(initialOwner);
  useEffect(() => {
    if (isOpen) setOwner(initialOwner);
  }, [isOpen, initialOwner]);

  const router = useRouter();

  const handleCreateDrive = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!driveName.trim() || isSubmitting) return;
    setIsSubmitting(true);
    try {
      const body = owner === PERSONAL ? { name: driveName } : { name: driveName, orgId: owner };
      const newDrive = await post<Drive>("/api/drives", body);
      // Add the drive with correct ownership flag
      addDrive(newDrive);
      setCurrentDrive(newDrive.id);
      // Force a refresh to ensure all drives have correct data
      await fetchDrives();
      router.push(`/dashboard/${newDrive.id}`);
      setDriveName("");
      setIsOpen(false);
    } catch (error) {
      // The server's refusal (who may create drives in the org, a lapsed org) is written for people.
      toast.error(error instanceof Error && error.message ? error.message : "The drive could not be created.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a new drive</DialogTitle>
          <DialogDescription>
            Enter a name for your new drive.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleCreateDrive}>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="name" className="text-right">
                Name
              </Label>
              <Input
                id="name"
                value={driveName}
                onChange={(e) => setDriveName(e.target.value)}
                className="col-span-3"
                autoFocus
              />
            </div>
            {offered.length > 0 ? (
              <div className="grid grid-cols-4 items-center gap-4">
                <Label className="text-right">Owner</Label>
                <Select value={owner} onValueChange={setOwner}>
                  <SelectTrigger aria-label="Owner" className="col-span-3">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={PERSONAL}>Personal</SelectItem>
                    {offered.map((org) => (
                      <SelectItem key={org.id} value={org.id}>{org.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Creating...' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
