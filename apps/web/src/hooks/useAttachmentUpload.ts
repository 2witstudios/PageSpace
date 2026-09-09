'use client';

import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import { createId } from '@paralleldrive/cuid2';
import { useEditingStore } from '@/stores/useEditingStore';
import { uploadAttachment } from '@/lib/upload/attachment-client';
import { MAX_MESSAGE_ATTACHMENTS } from '@pagespace/lib/services/attachment-upload-core';

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
  /** Put files back in the composer after a send failed. */
  restoreAttachments: (restored: FileAttachment[]) => void;
}

export function useAttachmentUpload({
  uploadUrl,
  onUploaded,
}: UseAttachmentUploadOptions): UseAttachmentUploadReturn {
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  // Mirrors `attachments` for the upload callback, which must not close over
  // the state value: adding it to the dep list would change the callback's
  // identity on every upload, and reading it without would go stale.
  const attachmentsRef = useRef<FileAttachment[]>([]);
  attachmentsRef.current = attachments;
  const [isUploading, setIsUploading] = useState(false);
  const isUploadingRef = useRef(false);
  const onUploadedRef = useRef(onUploaded);
  onUploadedRef.current = onUploaded;

  const uploadFiles = useCallback(
    async (files: File[]) => {
      if (!uploadUrl || isUploadingRef.current || files.length === 0) return;

      // Client-side cap is UX — it keeps the user from uploading bytes the
      // send would reject. The server enforces the real limit, and the
      // database backs it with a CHECK on the attachment position.
      const room = MAX_MESSAGE_ATTACHMENTS - attachmentsRef.current.length;
      if (room <= 0) {
        toast.error(`A message can carry at most ${MAX_MESSAGE_ATTACHMENTS} files`);
        return;
      }
      const accepted = files.length > room ? files.slice(0, room) : files;
      if (accepted.length < files.length) {
        toast.error(
          `Only ${room} more file${room === 1 ? '' : 's'} can be attached to this message`,
        );
      }

      const sessionId = `attachment-upload-${createId()}`;
      const { startEditing, endEditing } = useEditingStore.getState();

      isUploadingRef.current = true;
      setIsUploading(true);
      startEditing(sessionId, 'form', { componentName: 'useAttachmentUpload' });

      try {
        const succeeded: FileAttachment[] = [];

        // Direct-to-S3: each file goes presign → PUT(Tigris) → complete. Serial so
        // the per-user upload semaphore isn't contended by one message's batch.
        for (const file of accepted) {
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

  /**
   * Return files to the composer when the send that consumed them failed.
   *
   * The composer clears optimistically on send, so a rejected POST used to
   * discard the upload — tolerable when that meant one file, wasteful now that
   * a send can carry ten. The bytes are already in S3; what is lost is the
   * chips, and re-attaching means re-uploading all of them.
   *
   * Skips the restore if the user has already started attaching something new,
   * so a late failure cannot overwrite a fresh selection. An upload in flight
   * counts as "something new" even though `attachments` is still empty: it is
   * only appended when the whole batch finishes, so without the ref check a
   * failure landing mid-upload would restore the old files and the completing
   * upload would then append the new ones on top of them.
   */
  const restoreAttachments = useCallback((restored: FileAttachment[]) => {
    if (restored.length === 0 || isUploadingRef.current) return;
    setAttachments((prev) => (prev.length > 0 ? prev : restored));
  }, []);

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
    restoreAttachments,
  };
}
