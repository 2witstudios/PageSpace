"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useDriveStore } from "@/hooks/useDrive";
interface CreateDriveDialogProps {
  isOpen: boolean;
  setIsOpen: (isOpen: boolean) => void;
}

export default function CreateDriveDialog({ isOpen, setIsOpen }: CreateDriveDialogProps) {
  const [driveName, setDriveName] = useState("");
  const { addDrive, setCurrentDrive } = useDriveStore();
  const router = useRouter();

  const handleCreateDrive = async () => {
    if (!driveName.trim()) return;
    try {
      const response = await fetch("/api/drives", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: 'include',
        body: JSON.stringify({ name: driveName }),
      });

      if (!response.ok) {
        throw new Error("Failed to create drive");
      }

      const newDrive = await response.json();
      addDrive(newDrive);
      setCurrentDrive(newDrive.id);
      router.push(`/dashboard/${newDrive.id}`);
      setDriveName("");
      setIsOpen(false);
    } catch (error) {
      console.error(error);
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
            />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={handleCreateDrive}>Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}