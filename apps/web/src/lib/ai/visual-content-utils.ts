/**
 * Visual Content Utilities
 * Helper functions for handling images and visual PDFs in AI conversations
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import sharp from 'sharp';

/**
 * Maximum file size for visual content (10MB)
 * Larger files might cause issues with API limits
 */
const MAX_VISUAL_FILE_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * Maximum dimensions for resized images
 * Images larger than this will be resized while maintaining aspect ratio
 */
const MAX_IMAGE_DIMENSION = 1920; // Max width or height in pixels

/**
 * JPEG compression quality for optimized images
 */
const JPEG_QUALITY = 85;

/**
 * Supported visual MIME types
 */
const SUPPORTED_VISUAL_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/tiff',
  'image/svg+xml',
  'application/pdf', // For visual PDFs
];

/**
 * Visual content data structure
 */
export interface VisualContent {
  mimeType: string;
  base64: string;
  sizeBytes: number;
}

/**
 * Result of loading visual content
 */
export interface LoadVisualResult {
  success: boolean;
  visualContent?: VisualContent;
  error?: string;
}

/**
 * Check if a MIME type is supported for visual processing
 */
export function isVisualMimeType(mimeType: string): boolean {
  return SUPPORTED_VISUAL_TYPES.includes(mimeType);
}

/**
 * Load visual content from filesystem with optimization
 * @param filePath - Relative path to the file (from storage root)
 * @param mimeType - MIME type of the file
 * @returns Visual content or error
 */
export async function loadVisualContent(
  filePath: string,
  mimeType: string
): Promise<LoadVisualResult> {
  try {
    // Get storage root from environment
    const STORAGE_ROOT = process.env.FILE_STORAGE_PATH || '/tmp/pagespace-files';
    const fullPath = join(STORAGE_ROOT, filePath);
    
    // Read the file
    let fileBuffer = await readFile(fullPath);
    const originalSize = fileBuffer.length;
    
    // Check file size
    if (originalSize > MAX_VISUAL_FILE_SIZE) {
      return {
        success: false,
        error: `File too large for visual processing (${(originalSize / 1024 / 1024).toFixed(2)}MB). Maximum size is 10MB.`,
      };
    }
    
    // Check if MIME type is supported
    if (!isVisualMimeType(mimeType)) {
      return {
        success: false,
        error: `Unsupported file type for visual processing: ${mimeType}`,
      };
    }
    
    // Optimize the image to reduce memory usage
    let finalMimeType = mimeType;
    if (mimeType.startsWith('image/') && mimeType !== 'image/svg+xml') {
      const optimized = await optimizeImage(fileBuffer, mimeType);
      fileBuffer = optimized.buffer;
      finalMimeType = optimized.mimeType;
      
      // Log optimization results
      if (fileBuffer.length < originalSize) {
        const reduction = ((1 - fileBuffer.length / originalSize) * 100).toFixed(1);
        console.log(`Visual content optimized: ${reduction}% size reduction`);
      }
    }
    
    // Convert to base64
    const base64Data = fileBuffer.toString('base64');
    
    // Clear the buffer to free memory immediately
    fileBuffer = Buffer.alloc(0);
    
    return {
      success: true,
      visualContent: {
        mimeType: finalMimeType,
        base64: base64Data,
        sizeBytes: base64Data.length, // Use base64 length for accurate size
      },
    };
  } catch (error) {
    console.error('Error loading visual content:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to load visual content',
    };
  }
}

/**
 * Format visual content for AI SDK message parts
 * Different providers may need different formats
 */
export function formatVisualContentForAI(
  visualContent: VisualContent
): Record<string, unknown> {
  const { mimeType, base64 } = visualContent;
  
  // Most providers use a similar format
  // The AI SDK will handle provider-specific conversions
  return {
    type: 'image',
    mimeType,
    image: base64, // AI SDK expects 'image' field for base64 data
  };
}

/**
 * Create a text description for visual content
 * Used when vision is not available
 */
export function getVisualContentDescription(
  title: string,
  mimeType: string,
  sizeBytes?: number
): string {
  const fileType = mimeType.split('/')[1]?.toUpperCase() || 'file';
  const sizeStr = sizeBytes ? ` (${(sizeBytes / 1024).toFixed(1)}KB)` : '';
  
  return `[Visual content: ${title} - ${fileType}${sizeStr}]`;
}

/**
 * Optimize image using Sharp to reduce memory usage
 * Resizes large images and applies compression
 */
export async function optimizeImage(
  buffer: Buffer,
  mimeType: string
): Promise<{ buffer: Buffer; mimeType: string }> {
  try {
    // Skip optimization for non-image types
    if (!mimeType.startsWith('image/') || mimeType === 'image/svg+xml') {
      return { buffer, mimeType };
    }

    // Get image metadata
    const metadata = await sharp(buffer).metadata();
    
    if (!metadata.width || !metadata.height) {
      return { buffer, mimeType };
    }

    // Check if image needs resizing
    const needsResize = metadata.width > MAX_IMAGE_DIMENSION || metadata.height > MAX_IMAGE_DIMENSION;
    
    // Initialize sharp instance
    let sharpInstance = sharp(buffer);
    
    // Resize if needed
    if (needsResize) {
      sharpInstance = sharpInstance.resize(MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION, {
        fit: 'inside',
        withoutEnlargement: true,
      });
    }

    // Apply format-specific optimizations
    let optimizedBuffer: Buffer;
    let outputMimeType = mimeType;
    
    if (mimeType === 'image/png') {
      // Keep PNG for images with transparency
      if (metadata.channels === 4 || metadata.hasAlpha) {
        optimizedBuffer = await sharpInstance
          .png({ compressionLevel: 8, quality: 90 })
          .toBuffer();
      } else {
        // Convert to JPEG if no transparency
        optimizedBuffer = await sharpInstance
          .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
          .toBuffer();
        outputMimeType = 'image/jpeg';
      }
    } else if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') {
      optimizedBuffer = await sharpInstance
        .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
        .toBuffer();
    } else if (mimeType === 'image/webp') {
      optimizedBuffer = await sharpInstance
        .webp({ quality: JPEG_QUALITY })
        .toBuffer();
    } else {
      // For other formats, convert to JPEG
      optimizedBuffer = await sharpInstance
        .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
        .toBuffer();
      outputMimeType = 'image/jpeg';
    }

    // Only use optimized version if it's actually smaller
    if (optimizedBuffer.length < buffer.length) {
      console.log(`Image optimized: ${(buffer.length / 1024).toFixed(1)}KB -> ${(optimizedBuffer.length / 1024).toFixed(1)}KB`);
      return { buffer: optimizedBuffer, mimeType: outputMimeType };
    } else {
      return { buffer, mimeType };
    }
  } catch (error) {
    console.error('Error optimizing image:', error);
    // Return original if optimization fails
    return { buffer, mimeType };
  }
}