'use client';

import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import { uploadFileToS3, type UploadedPage } from '@/lib/upload/orchestrator';

interface UseDirectUploadOptions {
  driveId: string;
  parentId?: string | null;
  onUploaded?: (page: UploadedPage) => void;
}

interface UseDirectUploadReturn {
  isUploading: boolean;
  progress: number;
  uploadFiles: (files: File[]) => Promise<void>;
}

/**
 * Assembles the direct-to-S3 orchestrator into a React hook. All upload logic
 * lives in the composed orchestrator functions; this hook only manages the
 * uploading/progress flags and surfaces per-file failures.
 */
export function useDirectUpload({
  driveId,
  parentId,
  onUploaded,
}: UseDirectUploadOptions): UseDirectUploadReturn {
  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const onUploadedRef = useRef(onUploaded);
  onUploadedRef.current = onUploaded;

  const uploadFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setIsUploading(true);
      setProgress(0);

      try {
        for (const file of files) {
          try {
            const page = await uploadFileToS3(file, { driveId, parentId: parentId ?? null }, setProgress);
            onUploadedRef.current?.(page);
          } catch (err) {
            toast.error(err instanceof Error ? err.message : `Failed to upload ${file.name}`);
          }
        }
      } finally {
        setIsUploading(false);
        setProgress(0);
      }
    },
    [driveId, parentId],
  );

  return { isUploading, progress, uploadFiles };
}
