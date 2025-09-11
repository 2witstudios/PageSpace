'use client';

import { useState, useRef } from 'react';
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
import { Upload } from 'lucide-react';

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
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!driveId) {
      toast.error('Cannot create a page without a drive context.');
      return;
    }
    
    // Handle FILE type upload
    if (type === PageType.FILE) {
      if (!selectedFile) {
        toast.error('Please select a file to upload');
        return;
      }
      
      setIsSubmitting(true);
      try {
        const formData = new FormData();
        formData.append('file', selectedFile);
        formData.append('driveId', driveId);
        if (parentId) {
          formData.append('parentId', parentId);
        }
        if (title) {
          formData.append('title', title);
        }

        const response = await fetch('/api/upload', {
          method: 'POST',
          body: formData,
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || 'Failed to upload file');
        }

        const result = await response.json();
        toast.success('File uploaded successfully');
        onPageCreated(result.page);
        setIsOpen(false);
        setTitle('');
        setSelectedFile(null);
        router.push(`/dashboard/${driveId}/${result.page.id}`);
      } catch (error) {
        toast.error((error as Error).message);
      } finally {
        setIsSubmitting(false);
      }
      return;
    }
    
    // Handle other page types
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


  // Handle file selection
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setSelectedFile(file);
      // Use filename as title if title is empty
      if (!title) {
        setTitle(file.name);
      }
    }
  };

  // Trigger file picker when FILE type is selected
  const handleTypeChange = (value: string) => {
    setType(value as PageType);
    if (value === PageType.FILE) {
      // Trigger file picker after a small delay to allow UI update
      setTimeout(() => {
        fileInputRef.current?.click();
      }, 100);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => {
      setIsOpen(open);
      // Reset state when closing
      if (!open) {
        setTitle('');
        setSelectedFile(null);
        setType(PageType.DOCUMENT);
      }
    }}>
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
                required={type !== PageType.FILE}
                placeholder={type === PageType.FILE && selectedFile ? selectedFile.name : ''}
              />
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="type" className="text-right">
                Type
              </Label>
              <Select value={type} onValueChange={handleTypeChange}>
                <SelectTrigger className="col-span-3">
                  <SelectValue placeholder="Select a page type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="DOCUMENT">Document</SelectItem>
                  <SelectItem value="FOLDER">Folder</SelectItem>
                  <SelectItem value="CHANNEL">Channel</SelectItem>
                  <SelectItem value="AI_CHAT">AI Chat</SelectItem>
                  <SelectItem value="CANVAS">Canvas</SelectItem>
                  <SelectItem value="FILE">File Upload</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {type === PageType.FILE && (
              <div className="grid grid-cols-4 items-center gap-4">
                <Label className="text-right">File</Label>
                <div className="col-span-3">
                  <input
                    ref={fileInputRef}
                    type="file"
                    onChange={handleFileSelect}
                    className="hidden"
                    accept="*/*"
                  />
                  {selectedFile ? (
                    <div className="flex items-center gap-2">
                      <span className="text-sm truncate">{selectedFile.name}</span>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => fileInputRef.current?.click()}
                      >
                        Change
                      </Button>
                    </div>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => fileInputRef.current?.click()}
                      className="w-full"
                    >
                      <Upload className="mr-2 h-4 w-4" />
                      Select File
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button type="submit" disabled={isSubmitting || (type === PageType.FILE && !selectedFile)}>
              {isSubmitting ? 'Creating...' : type === PageType.FILE ? 'Upload File' : 'Create Page'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}