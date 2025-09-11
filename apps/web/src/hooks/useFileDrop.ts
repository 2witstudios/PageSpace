'use client';

import { useState, useCallback, DragEvent } from 'react';
import { toast } from 'sonner';

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

  const handleFileDrop = useCallback(async (e: DragEvent, customParentId?: string | null) => {
    if (!isFileDrag(e)) return;
    
    e.preventDefault();
    e.stopPropagation();
    
    setState(prev => ({ ...prev, isDraggingFiles: false }));

    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    setState(prev => ({ ...prev, isUploading: true, uploadProgress: 0 }));

    try {
      const uploadedPages = [];
      const totalFiles = files.length;
      
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        
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

        const response = await fetch('/api/upload', {
          method: 'POST',
          body: formData,
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || `Failed to upload ${file.name}`);
        }

        const result = await response.json();
        uploadedPages.push(result.page);
      }

      toast.success(`Successfully uploaded ${uploadedPages.length} file(s)`);
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