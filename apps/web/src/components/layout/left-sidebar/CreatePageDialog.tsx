'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageType, Page } from '@pagespace/lib/client';
import { toast } from 'sonner';

interface CreatePageDialogProps {
  parentId: string | null;
  isOpen: boolean;
  setIsOpen: (isOpen: boolean) => void;
  onPageCreated: (newPage: Page) => void;
  driveId: string;
}

export default function CreatePageDialog({ parentId, isOpen, setIsOpen, onPageCreated, driveId }: CreatePageDialogProps) {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [type, setType] = useState<PageType>(PageType.DOCUMENT);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!driveId) {
      toast.error('Cannot create a page without a drive context.');
      return;
    }
    setIsSubmitting(true);
    try {
      let content: Record<string, unknown> | string[] | string = {};
      if (type === 'DOCUMENT') {
        content = '';
      } else if (type === 'CHANNEL' || type === 'AI_CHAT') {
        content = { messages: [] };
      } else if (type === 'CANVAS') {
        content = '';
      }

      const response = await fetch('/api/pages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          type,
          parentId: parentId,
          driveId: driveId,
          content
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to create page');
      }

      const newPage = await response.json();
      toast.success('Page created successfully');
      onPageCreated(newPage);
      setIsOpen(false);
      setTitle('');
      router.push(`/dashboard/${driveId}/${newPage.id}`);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setIsSubmitting(false);
    }
  };


  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Create New Page</DialogTitle>
          <DialogDescription>
            Choose a title and type for your new page.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="title" className="text-right">
                Title
              </Label>
              <Input
                id="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="col-span-3"
                required
              />
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="type" className="text-right">
                Type
              </Label>
              <Select value={type} onValueChange={(value) => setType(value as PageType)}>
                <SelectTrigger className="col-span-3">
                  <SelectValue placeholder="Select a page type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="DOCUMENT">Document</SelectItem>
                  <SelectItem value="FOLDER">Folder</SelectItem>
                  <SelectItem value="CHANNEL">Channel</SelectItem>
                  <SelectItem value="AI_CHAT">AI Chat</SelectItem>
                  <SelectItem value="CANVAS">Canvas</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Creating...' : 'Create Page'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}