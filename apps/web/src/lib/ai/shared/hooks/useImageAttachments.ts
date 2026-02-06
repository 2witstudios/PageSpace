'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
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

    // Enforce max count
    setAttachments((prev) => {
      const remaining = MAX_IMAGES_PER_MESSAGE - prev.length;
      if (remaining <= 0) return prev;

      const toAdd = imageFiles.slice(0, remaining);
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

      // Kick off async resize for each new attachment
      toAdd.forEach((file, i) => {
        const attachmentId = newAttachments[i].id;
        resizeImageForVision(file).then((result) => {
          setAttachments((current) =>
            current.map((a) =>
              a.id === attachmentId
                ? { ...a, dataUrl: result.dataUrl, mediaType: result.mediaType, processing: false }
                : a
            )
          );
        }).catch((error) => {
          console.error('Failed to resize image:', error);
          // Remove failed attachment
          setAttachments((current) => current.filter((a) => a.id !== attachmentId));
        });
      });

      return [...prev, ...newAttachments];
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
