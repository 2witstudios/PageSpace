'use client';

import { useCallback, useRef, useState } from 'react';
import { FolderOpen, Plus, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useEditingStore } from '@/stores/useEditingStore';
import { useUIStore } from '@/stores/useUIStore';

interface FilesEmptyStateProps {
  driveId: string;
  parentId: string | null;
  canWrite: boolean;
  onMutate: () => void;
}

const uploadOne = async (file: File, driveId: string, parentId: string | null) => {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('driveId', driveId);
  if (parentId) {
    formData.append('parentId', parentId);
  }
  const response = await fetchWithAuth('/api/upload', { method: 'POST', body: formData });
  if (!response.ok) {
    const err = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Failed to upload ${file.name}`);
  }
};

export function FilesEmptyState({ driveId, parentId, canWrite, onMutate }: FilesEmptyStateProps) {
  const [isDropActive, setIsDropActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const openQuickCreate = useUIStore((s) => s.openQuickCreate);

  const headline = parentId ? 'No child pages' : 'No pages in this drive';

  const uploadBatch = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      const sessionId = `files-empty-upload-${Date.now()}`;
      useEditingStore.getState().startEditing(sessionId, 'form', { componentName: 'FilesEmptyState' });
      try {
        for (const file of files) {
          try {
            await uploadOne(file, driveId, parentId);
          } catch (error) {
            toast.error((error as Error).message);
          }
        }
        onMutate();
      } finally {
        useEditingStore.getState().endEditing(sessionId);
      }
    },
    [driveId, parentId, onMutate]
  );

  if (!canWrite) {
    return (
      <div
        data-testid="files-empty-state-readonly"
        className="flex flex-col items-center justify-center py-16 text-center"
      >
        <FolderOpen className="h-12 w-12 text-muted-foreground/50 mb-4" aria-hidden="true" />
        <p className="text-muted-foreground mb-1">{headline}</p>
        <p className="text-sm text-muted-foreground/70">
          You have view-only access to this drive.
        </p>
      </div>
    );
  }

  const handleDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    setIsDropActive(true);
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    setIsDropActive(true);
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null;
    if (next && event.currentTarget.contains(next)) return;
    setIsDropActive(false);
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDropActive(false);
    const files = Array.from(event.dataTransfer.files ?? []);
    void uploadBatch(files);
  };

  const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    void uploadBatch(files);
  };

  return (
    <div
      data-testid="files-empty-state"
      data-drop-active={isDropActive ? 'true' : 'false'}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`flex flex-col items-center justify-center py-16 text-center rounded-lg border-2 border-dashed transition-colors ${
        isDropActive ? 'border-primary bg-primary/5' : 'border-transparent'
      }`}
    >
      <FolderOpen className="h-12 w-12 text-muted-foreground/50 mb-4" aria-hidden="true" />
      <p className="text-muted-foreground mb-2">{headline}</p>
      <p className="text-sm text-muted-foreground/70 mb-6">
        Upload files or create a page to get started
      </p>
      <div className="flex gap-2">
        <Button onClick={() => fileInputRef.current?.click()}>
          <Upload className="mr-2 h-4 w-4" />
          Upload files
        </Button>
        <Button variant="outline" onClick={() => openQuickCreate(parentId)}>
          <Plus className="mr-2 h-4 w-4" />
          Create page
        </Button>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        data-testid="files-upload-input"
        className="hidden"
        onChange={handleInputChange}
      />
    </div>
  );
}
