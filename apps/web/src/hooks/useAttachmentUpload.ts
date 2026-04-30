'use client';

import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useEditingStore } from '@/stores/useEditingStore';

export interface FileAttachment {
  id: string;
  originalName: string;
  size: number;
  mimeType: string;
  contentHash: string;
}

interface UseAttachmentUploadOptions {
  uploadUrl: string | null | undefined;
  onUploaded?: (attachment: FileAttachment) => void;
}

interface UseAttachmentUploadReturn {
  attachment: FileAttachment | null;
  isUploading: boolean;
  uploadFile: (file: File) => Promise<void>;
  clearAttachment: () => void;
  setAttachment: (attachment: FileAttachment | null) => void;
}

let sessionCounter = 0;

export function useAttachmentUpload({
  uploadUrl,
  onUploaded,
}: UseAttachmentUploadOptions): UseAttachmentUploadReturn {
  const [attachment, setAttachment] = useState<FileAttachment | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const onUploadedRef = useRef(onUploaded);
  onUploadedRef.current = onUploaded;

  const uploadFile = useCallback(
    async (file: File) => {
      if (!uploadUrl) return;

      const sessionId = `attachment-upload-${++sessionCounter}-${Date.now()}`;
      const { startEditing, endEditing } = useEditingStore.getState();

      setIsUploading(true);
      startEditing(sessionId, 'form', { componentName: 'useAttachmentUpload' });

      try {
        const formData = new FormData();
        formData.append('file', file);

        const response = await fetchWithAuth(uploadUrl, {
          method: 'POST',
          body: formData,
        });

        if (!response.ok) {
          const errorData = await response
            .json()
            .catch(() => ({ error: 'Upload failed' }));
          if (response.status === 413) {
            toast.error(errorData.error || 'File too large');
          } else if (response.status === 429) {
            toast.error('Too many uploads in progress. Please wait.');
          } else if (response.status === 503) {
            toast.error('Server is busy. Please try again later.');
          } else if (response.status === 403) {
            toast.error(
              errorData.error || 'You do not have permission to upload files here.'
            );
          } else {
            toast.error(errorData.error || 'Upload failed');
          }
          return;
        }

        const result = await response.json();
        const next: FileAttachment = {
          id: result.file.id,
          originalName: result.file.originalName,
          size: result.file.size,
          mimeType: result.file.mimeType,
          contentHash: result.file.contentHash,
        };
        setAttachment(next);
        onUploadedRef.current?.(next);
      } catch (error) {
        console.error('Failed to upload file:', error);
        toast.error('Failed to upload file. Please try again.');
      } finally {
        setIsUploading(false);
        endEditing(sessionId);
      }
    },
    [uploadUrl]
  );

  const clearAttachment = useCallback(() => setAttachment(null), []);

  return {
    attachment,
    isUploading,
    uploadFile,
    clearAttachment,
    setAttachment,
  };
}
