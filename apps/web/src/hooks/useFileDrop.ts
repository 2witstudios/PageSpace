'use client';

import { useState, useCallback, DragEvent } from 'react';
import { toast } from 'sonner';
import { formatBytes } from '@pagespace/lib/services/storage-limits';
import { post } from '@/lib/auth/auth-fetch';
import { uploadFileToS3, type UploadedPage } from '@/lib/upload/orchestrator';

interface FileDropState {
  isDraggingFiles: boolean;
  isUploading: boolean;
  uploadProgress: number;
}

interface UseFileDropOptions {
  driveId: string;
  parentId?: string | null;
  onUploadComplete?: (pages: UploadedPage[]) => void;
  onUploadError?: (error: Error) => void;
}

export function useFileDrop({
  driveId,
  parentId = null,
  onUploadComplete,
  onUploadError
}: UseFileDropOptions) {
  const [state, setState] = useState<FileDropState>({
    isDraggingFiles: false,
    isUploading: false,
    uploadProgress: 0
  });

  const isFileDrag = useCallback((e: DragEvent) => {
    if (!e.dataTransfer?.types) return false;
    return Array.from(e.dataTransfer.types).includes('Files');
  }, []);

  const handleDragEnter = useCallback((e: DragEvent) => {
    if (isFileDrag(e)) {
      e.preventDefault();
      e.stopPropagation();
      setState(prev => ({ ...prev, isDraggingFiles: true }));
    }
  }, [isFileDrag]);

  const handleDragLeave = useCallback((e: DragEvent) => {
    if (isFileDrag(e)) {
      e.preventDefault();
      e.stopPropagation();

      // Only set to false if we're leaving the entire drop zone
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX;
      const y = e.clientY;

      if (x <= rect.left || x >= rect.right || y <= rect.top || y >= rect.bottom) {
        setState(prev => ({ ...prev, isDraggingFiles: false }));
      }
    }
  }, [isFileDrag]);

  const handleDragOver = useCallback((e: DragEvent) => {
    if (isFileDrag(e)) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
    }
  }, [isFileDrag]);

  const handleFileDrop = useCallback(async (
    e: DragEvent,
    customParentId?: string | null,
    position?: 'before' | 'after' | null,
    afterNodeId?: string | null
  ) => {
    if (!isFileDrag(e)) return;

    e.preventDefault();
    e.stopPropagation();

    setState(prev => ({ ...prev, isDraggingFiles: false }));

    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    // Pre-validate file sizes client-side
    const maxFileSize = parseInt(process.env.NEXT_PUBLIC_STORAGE_MAX_FILE_SIZE_MB || '20') * 1024 * 1024;

    const oversizedFiles = files.filter(f => f.size > maxFileSize);
    if (oversizedFiles.length > 0) {
      const fileNames = oversizedFiles.map(f => `${f.name} (${formatBytes(f.size)})`).join(', ');
      toast.error(`Files exceed ${formatBytes(maxFileSize)} limit: ${fileNames}`);
      return;
    }

    // Check storage quota before uploading. Per-file quota is also enforced
    // server-side at presign time; this is an early, friendlier guard.
    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    try {
      await post('/api/storage/check', { fileSize: totalSize });
    } catch (error) {
      console.error('Storage check failed:', error);
      const errorMessage = (error as Error).message;
      if (errorMessage.includes('429')) {
        toast.error('Too many uploads in progress. Please wait a moment.');
      } else if (errorMessage.includes('503')) {
        toast.error('Server is busy. Please try again later.');
      } else {
        toast.error('Upload not allowed');
      }
      return;
    }

    setState(prev => ({ ...prev, isUploading: true, uploadProgress: 0 }));

    // customParentId can be explicitly null (drop at root), so distinguish
    // "not passed" (undefined) from "passed as null".
    const targetParentId = customParentId !== undefined ? customParentId : parentId;

    try {
      const uploadedPages: UploadedPage[] = [];
      const totalFiles = files.length;

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        try {
          const page = await uploadFileToS3(
            file,
            { driveId, parentId: targetParentId, position, afterNodeId },
            (pct) => setState(prev => ({
              ...prev,
              uploadProgress: ((i + pct / 100) / totalFiles) * 100,
            })),
          );
          uploadedPages.push(page);
          setState(prev => ({ ...prev, uploadProgress: ((i + 1) / totalFiles) * 100 }));
        } catch (error) {
          toast.error(error instanceof Error ? error.message : `Failed to upload ${file.name}`);
        }
      }

      if (uploadedPages.length > 0) {
        toast.success(`Successfully uploaded ${uploadedPages.length} of ${files.length} file(s)`);
      } else if (files.length > 0) {
        toast.error('No files were uploaded successfully');
      }
      onUploadComplete?.(uploadedPages);

    } catch (error) {
      console.error('File upload error:', error);
      toast.error((error as Error).message);
      onUploadError?.(error as Error);
    } finally {
      setState(prev => ({
        ...prev,
        isUploading: false,
        uploadProgress: 0
      }));
    }
  }, [driveId, parentId, isFileDrag, onUploadComplete, onUploadError]);

  const resetDragState = useCallback(() => {
    setState(prev => ({ ...prev, isDraggingFiles: false }));
  }, []);

  return {
    ...state,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleFileDrop,
    resetDragState,
    isFileDrag
  };
}
