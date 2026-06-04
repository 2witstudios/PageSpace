'use client';

import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import { createId } from '@paralleldrive/cuid2';
import { useEditingStore } from '@/stores/useEditingStore';
import { uploadAttachment } from '@/lib/upload/attachment-client';

export interface FileAttachment {
  /** Client-side unique key for UI tracking (e.g. remove-by-slot). NOT the server file id. */
  instanceId: string;
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
        const succeeded: FileAttachment[] = [];

        // Direct-to-S3: each file goes presign → PUT(Tigris) → complete. Serial so
        // the per-user upload semaphore isn't contended by one message's batch.
        for (const file of files) {
          const result = await uploadAttachment(uploadUrl, file);
          if (result.ok) {
            const attachment: FileAttachment = {
              instanceId: createId(),
              id: result.attachment.id,
              originalName: result.attachment.originalName,
              size: result.attachment.size,
              mimeType: result.attachment.mimeType,
              contentHash: result.attachment.contentHash,
            };
            succeeded.push(attachment);
            onUploadedRef.current?.(attachment);
          } else {
            toast.error(result.errorMessage || `Failed to upload ${file.name || 'file'}`);
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
    (instanceId: string) => setAttachments(prev => prev.filter(a => a.instanceId !== instanceId)),
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
