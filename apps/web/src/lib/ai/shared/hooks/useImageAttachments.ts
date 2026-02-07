'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { toast } from 'sonner';
import { resizeImageForVision, MAX_IMAGES_PER_MESSAGE } from '../utils/image-resize';

export interface ImageAttachment {
  id: string;
  filename: string;
  mediaType: string;
  /** Blob URL for local preview (revoked on cleanup) */
  previewUrl: string;
  /** Data URL set after resize (used for sending to AI) */
  dataUrl?: string;
  /** Whether this attachment is still being processed (resizing) */
  processing: boolean;
}

/**
 * Hook for managing image attachments in AI chat inputs.
 * Handles file validation, client-side resize, blob URL lifecycle, and data URL conversion.
 */
export function useImageAttachments() {
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const attachmentsRef = useRef<ImageAttachment[]>([]);
  attachmentsRef.current = attachments;
  const blobUrlsRef = useRef<Set<string>>(new Set());

  // Cleanup blob URLs on unmount
  useEffect(() => {
    return () => {
      blobUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      blobUrlsRef.current.clear();
    };
  }, []);

  const addFiles = useCallback(async (files: File[]) => {
    const imageFiles = files.filter((f) => f.type.startsWith('image/'));
    if (imageFiles.length === 0) return;

    // Read current count outside the updater to determine capacity
    const currentCount = attachmentsRef.current.length;
    const remaining = MAX_IMAGES_PER_MESSAGE - currentCount;
    if (remaining <= 0) {
      toast.info(`Maximum ${MAX_IMAGES_PER_MESSAGE} images per message`);
      return;
    }

    const toAdd = imageFiles.slice(0, remaining);
    if (toAdd.length < imageFiles.length) {
      toast.info(`Added ${toAdd.length} of ${imageFiles.length} images (max ${MAX_IMAGES_PER_MESSAGE})`);
    }

    // Create blob URLs and attachment objects outside the state updater
    const newAttachments: ImageAttachment[] = toAdd.map((file) => {
      const previewUrl = URL.createObjectURL(file);
      blobUrlsRef.current.add(previewUrl);
      return {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        filename: file.name,
        mediaType: file.type,
        previewUrl,
        processing: true,
      };
    });

    // Pure state update
    setAttachments((prev) => [...prev, ...newAttachments]);

    // Kick off async resize for each new attachment (outside updater)
    toAdd.forEach((file, i) => {
      const attachment = newAttachments[i];
      resizeImageForVision(file).then((result) => {
        setAttachments((current) =>
          current.map((a) =>
            a.id === attachment.id
              ? { ...a, dataUrl: result.dataUrl, mediaType: result.mediaType, processing: false }
              : a
          )
        );
      }).catch((error) => {
        console.error('Failed to resize image:', error);
        // Revoke leaked blob URL and remove failed attachment
        URL.revokeObjectURL(attachment.previewUrl);
        blobUrlsRef.current.delete(attachment.previewUrl);
        setAttachments((current) => current.filter((a) => a.id !== attachment.id));
      });
    });
  }, []);

  const removeFile = useCallback((id: string) => {
    setAttachments((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target) {
        URL.revokeObjectURL(target.previewUrl);
        blobUrlsRef.current.delete(target.previewUrl);
      }
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  const clearFiles = useCallback(() => {
    setAttachments((prev) => {
      prev.forEach((a) => {
        URL.revokeObjectURL(a.previewUrl);
        blobUrlsRef.current.delete(a.previewUrl);
      });
      return [];
    });
  }, []);

  /**
   * Convert attachments to FileUIPart[] for sending via AI SDK.
   * Waits for any pending resizes to complete.
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
