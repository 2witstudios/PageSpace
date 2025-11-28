'use client';

import { useState, useCallback, DragEvent } from 'react';
import { toast } from 'sonner';
import { formatBytes } from '@pagespace/lib/services/storage-limits';
import { post, fetchWithAuth } from '@/lib/auth/auth-fetch';

interface FileDropState {
  isDraggingFiles: boolean;
  isUploading: boolean;
  uploadProgress: number;
}

interface UploadedPage {
  id: string;
  title: string;
  type: string;
  [key: string]: unknown;
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
    const MAX_CONCURRENT_UPLOADS = 2;

    // Check for oversized files
    const oversizedFiles = files.filter(f => f.size > maxFileSize);
    if (oversizedFiles.length > 0) {
      const fileNames = oversizedFiles.map(f => `${f.name} (${formatBytes(f.size)})`).join(', ');
      toast.error(`Files exceed ${formatBytes(maxFileSize)} limit: ${fileNames}`);
      return;
    }

    // Check storage quota before uploading
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

    try {
      const uploadedPages = [];
      const totalFiles = files.length;
      let activeUploads = 0;
      
      for (let i = 0; i < files.length; i++) {
        const file = files[i];

        // Limit concurrent uploads
        while (activeUploads >= MAX_CONCURRENT_UPLOADS) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }

        activeUploads++;
        
        // Update progress
        setState(prev => ({ 
          ...prev, 
          uploadProgress: ((i + 1) / totalFiles) * 100 
        }));

        const formData = new FormData();
        formData.append('file', file);
        formData.append('driveId', driveId);
        
        const targetParentId = customParentId !== undefined ? customParentId : parentId;
        if (targetParentId) {
          formData.append('parentId', targetParentId);
        }
        
        // Add position data if provided
        if (position) {
          formData.append('position', position);
        }
        if (afterNodeId) {
          formData.append('afterNodeId', afterNodeId);
        }

        try {
          const response = await fetchWithAuth('/api/upload', {
            method: 'POST',
            body: formData,
          });

          if (!response.ok) {
            const errorData = await response.json();
            if (response.status === 413) {
              toast.error(`${file.name}: ${errorData.error}`);
              if (errorData.storageInfo) {
                const { formattedUsed, formattedQuota } = errorData.storageInfo;
                toast.error(`Storage: ${formattedUsed} / ${formattedQuota} used`);
              }
            } else if (response.status === 429) {
              toast.error('Too many concurrent uploads. Waiting...');
              // Wait before retrying
              await new Promise(resolve => setTimeout(resolve, 2000));
              i--; // Retry this file
              continue;
            } else if (response.status === 503) {
              toast.error('Server busy. Waiting...');
              await new Promise(resolve => setTimeout(resolve, 3000));
              i--; // Retry this file
              continue;
            } else {
              throw new Error(errorData.error || `Failed to upload ${file.name}`);
            }
          } else {
            const result = await response.json();
            uploadedPages.push(result.page);

            // Show storage info if available
            if (result.storageInfo) {
              const percent = (result.storageInfo.used / result.storageInfo.quota) * 100;
              if (percent > 80) {
                toast.warning(`Storage ${percent.toFixed(0)}% full`);
              }
            }
          }
        } finally {
          activeUploads--;
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