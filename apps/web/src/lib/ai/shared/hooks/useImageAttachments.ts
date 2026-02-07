'use client';

import { useState, useCallback, useRef } from 'react';
import { createId } from '@paralleldrive/cuid2';
import { toast } from 'sonner';
import { resizeImageForVision, MAX_IMAGES_PER_MESSAGE } from '../utils/image-resize';

export interface ImageAttachment {
  id: string;
  filename: string;
  mediaType: string;
  /** Data URL for preview (set after resize completes) */
  previewUrl: string;
  /** Data URL set after resize (used for sending to AI) */
  dataUrl?: string;
  /** Whether this attachment is still being processed (resizing) */
  processing: boolean;
}

/**
 * Hook for managing image attachments in AI chat inputs.
 * Handles file validation, client-side resize, and data URL conversion.
 */
export function useImageAttachments() {
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const countRef = useRef(0);
  countRef.current = attachments.length;

  const addFiles = useCallback(async (files: File[]) => {
    const imageFiles = files.filter((f) => f.type.startsWith('image/'));
    if (imageFiles.length === 0) return;

    const remaining = MAX_IMAGES_PER_MESSAGE - countRef.current;
    if (remaining <= 0) {
      toast.info(`Maximum ${MAX_IMAGES_PER_MESSAGE} images per message`);
      return;
    }

    const toAdd = imageFiles.slice(0, remaining);
    if (toAdd.length < imageFiles.length) {
      toast.info(`Added ${toAdd.length} of ${imageFiles.length} images (max ${MAX_IMAGES_PER_MESSAGE})`);
    }

    const newAttachments: ImageAttachment[] = toAdd.map((file) => ({
      id: createId(),
      filename: file.name,
      mediaType: file.type,
      previewUrl: '',
      processing: true,
    }));

    setAttachments((prev) => [...prev, ...newAttachments]);

    toAdd.forEach((file, i) => {
      const attachmentId = newAttachments[i].id;
      resizeImageForVision(file)
        .then((result) => {
          setAttachments((current) =>
            current.map((a) =>
              a.id === attachmentId
                ? { ...a, previewUrl: result.dataUrl, dataUrl: result.dataUrl, mediaType: result.mediaType, processing: false }
                : a
            )
          );
        })
        .catch((error) => {
          console.error('Failed to resize image:', error);
          setAttachments((current) => current.filter((a) => a.id !== attachmentId));
        });
    });
  }, []);

  const removeFile = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const clearFiles = useCallback(() => {
    setAttachments([]);
  }, []);

  /**
   * Convert attachments to FileUIPart[] for sending via AI SDK.
   * Excludes any attachments still being processed (resizing).
   * Returns array of { type: 'file', url: dataUrl, mediaType, filename }.
   */
  const getFilesForSend = useCallback((): Array<{
    type: 'file';
    url: string;
    mediaType: string;
    filename: string;
  }> => {
    return attachments
      .filter((a) => !a.processing && a.dataUrl)
      .map((a) => ({
        type: 'file' as const,
        url: a.dataUrl!,
        mediaType: a.mediaType,
        filename: a.filename,
      }));
  }, [attachments]);

  const hasProcessingFiles = attachments.some((a) => a.processing);

  return {
    attachments,
    addFiles,
    removeFile,
    clearFiles,
    getFilesForSend,
    hasProcessingFiles,
    hasAttachments: attachments.length > 0,
  };
}
