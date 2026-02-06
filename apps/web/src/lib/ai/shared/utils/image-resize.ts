/**
 * Client-side image resize utility for AI vision input.
 * Resizes images to a maximum dimension to keep payloads manageable
 * while preserving quality for vision models.
 */

export const MAX_VISION_DIMENSION = 2048;
export const JPEG_QUALITY = 0.85;
export const MAX_IMAGE_SIZE_BYTES = 4 * 1024 * 1024; // 4MB per image
export const MAX_IMAGES_PER_MESSAGE = 5;

export interface ResizeResult {
  dataUrl: string;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  dataUrlLength: number;
  mediaType: string;
}

/**
 * Calculate dimensions that fit within maxDimension while preserving aspect ratio.
 */
export const calculateResizeDimensions = (
  width: number,
  height: number,
  maxDimension: number
): { width: number; height: number; wasResized: boolean } => {
  if (width <= maxDimension && height <= maxDimension) {
    return { width, height, wasResized: false };
  }

  const ratio = Math.min(maxDimension / width, maxDimension / height);
  return {
    width: Math.round(width * ratio),
    height: Math.round(height * ratio),
    wasResized: true,
  };
};

/**
 * Determine output media type based on the source image type.
 * PNGs with transparency stay as PNG, everything else becomes JPEG for smaller size.
 */
export const getOutputMediaType = (sourceType: string): string => {
  if (sourceType === 'image/png' || sourceType === 'image/gif') {
    return 'image/png';
  }
  return 'image/jpeg';
};

/**
 * Resize an image file for AI vision input.
 * Uses canvas to resize, outputs as JPEG (for photos) or PNG (for screenshots/transparency).
 */
export const resizeImageForVision = (
  file: File,
  maxDimension: number = MAX_VISION_DIMENSION
): Promise<ResizeResult> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(url);

      const { width, height, wasResized } = calculateResizeDimensions(
        img.naturalWidth,
        img.naturalHeight,
        maxDimension
      );

      if (!wasResized) {
        // No resize needed — convert to data URL directly
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          resolve({
            dataUrl,
            width: img.naturalWidth,
            height: img.naturalHeight,
            originalWidth: img.naturalWidth,
            originalHeight: img.naturalHeight,
            dataUrlLength: dataUrl.length,
            mediaType: file.type || 'image/jpeg',
          });
        };
        reader.onerror = () => reject(new Error('Failed to read image file'));
        reader.readAsDataURL(file);
        return;
      }

      // Resize via canvas
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Failed to get canvas context'));
        return;
      }

      ctx.drawImage(img, 0, 0, width, height);

      const outputType = getOutputMediaType(file.type);
      const quality = outputType === 'image/jpeg' ? JPEG_QUALITY : undefined;
      const dataUrl = canvas.toDataURL(outputType, quality);

      resolve({
        dataUrl,
        width,
        height,
        originalWidth: img.naturalWidth,
        originalHeight: img.naturalHeight,
        dataUrlLength: dataUrl.length,
        mediaType: outputType,
      });
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image'));
    };

    img.src = url;
  });
};

