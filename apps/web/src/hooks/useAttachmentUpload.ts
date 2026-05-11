'use client';

import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import { createId } from '@paralleldrive/cuid2';
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
  attachments: FileAttachment[];
  /** Convenience alias for attachments[0] — preserved for single-file consumers */
  attachment: FileAttachment | null;
  isUploading: boolean;
  uploadFile: (file: File) => Promise<void>;
  uploadFiles: (files: File[]) => Promise<void>;
  clearAttachment: () => void;
  removeAttachment: (id: string) => void;
}

interface UploadErrorBody {
  error?: string;
}

interface UploadFileResult {
  success: boolean;
  file?: FileAttachment;
  error?: string;
  fileName?: string;
}

interface BatchUploadBody {
  files: UploadFileResult[];
}

export function useAttachmentUpload({
  uploadUrl,
  onUploaded,
}: UseAttachmentUploadOptions): UseAttachmentUploadReturn {
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const isUploadingRef = useRef(false);
  const onUploadedRef = useRef(onUploaded);
  onUploadedRef.current = onUploaded;

  const uploadFiles = useCallback(
    async (files: File[]) => {
      if (!uploadUrl || isUploadingRef.current || files.length === 0) return;

      const sessionId = `attachment-upload-${createId()}`;
      const { startEditing, endEditing } = useEditingStore.getState();

      isUploadingRef.current = true;
      setIsUploading(true);
      startEditing(sessionId, 'form', { componentName: 'useAttachmentUpload' });

      try {
        const formData = new FormData();
        for (const file of files) {
          formData.append('file', file);
        }

        const response = await fetchWithAuth(uploadUrl, {
          method: 'POST',
          body: formData,
        });

        if (!response.ok) {
          const errorData = (await response
            .json()
            .catch(() => ({ error: 'Upload failed' }))) as UploadErrorBody;
          if (response.status === 413) {
            toast.error(errorData.error || 'File too large');
          } else if (response.status === 429) {
            toast.error('Too many uploads in progress. Please wait.');
          } else if (response.status === 403) {
            toast.error(
              errorData.error || 'You do not have permission to upload files here.'
            );
          } else {
            toast.error(errorData.error || 'Upload failed');
          }
          return;
        }

        const body = (await response.json()) as BatchUploadBody;
        const succeeded: FileAttachment[] = [];

        for (const result of body.files ?? []) {
          if (result.success && result.file) {
            const attachment: FileAttachment = {
              id: result.file.id,
              originalName: result.file.originalName,
              size: result.file.size,
              mimeType: result.file.mimeType,
              contentHash: result.file.contentHash,
            };
            succeeded.push(attachment);
            onUploadedRef.current?.(attachment);
          } else {
            toast.error(result.error || `Failed to upload ${result.fileName ?? 'file'}`);
          }
        }

        if (succeeded.length > 0) {
          setAttachments(prev => [...prev, ...succeeded]);
        }
      } catch (error) {
        console.error('Failed to upload file(s):', error);
        toast.error('Failed to upload file. Please try again.');
      } finally {
        isUploadingRef.current = false;
        setIsUploading(false);
        endEditing(sessionId);
      }
    },
    [uploadUrl]
  );

  const uploadFile = useCallback(
    async (file: File) => {
      await uploadFiles([file]);
    },
    [uploadFiles]
  );

  const clearAttachment = useCallback(() => setAttachments([]), []);

  const removeAttachment = useCallback(
    (id: string) => setAttachments(prev => prev.filter(a => a.id !== id)),
    []
  );

  return {
    attachments,
    attachment: attachments[0] ?? null,
    isUploading,
    uploadFile,
    uploadFiles,
    clearAttachment,
    removeAttachment,
  };
}
