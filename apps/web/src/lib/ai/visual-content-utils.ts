/**
 * Visual Content Utilities
 * Helper functions for handling images and visual PDFs in AI conversations
 * Uses the processor service for all image optimization
 */

import crypto from 'crypto';

/**
 * Maximum file size for visual content (10MB)
 * Larger files might cause issues with API limits
 */
const MAX_VISUAL_FILE_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * Processor service URL
 */
const PROCESSOR_URL = process.env.PROCESSOR_URL || 'http://processor:3003';

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
  base64?: string;
  url?: string;
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
 * Check if provider supports URLs instead of base64
 */
function providerSupportsUrls(provider?: string): boolean {
  if (!provider) return false;
  const urlProviders = ['openai', 'anthropic', 'google'];
  return urlProviders.includes(provider.toLowerCase());
}

/**
 * Load visual content from filesystem with optimization via processor service
 * @param filePath - Relative path to the file (from storage root)
 * @param mimeType - MIME type of the file
 * @param provider - AI provider name (optional, for URL vs base64 decision)
 * @returns Visual content or error
 */
export async function loadVisualContent(
  filePath: string,
  mimeType: string,
  provider?: string
): Promise<LoadVisualResult> {
  try {
    // filePath is already the content hash for files stored in processor
    const contentHash = filePath;

    // Fetch the original file from processor service
    const fileResponse = await fetch(`${PROCESSOR_URL}/cache/${contentHash}/original`);

    if (!fileResponse.ok) {
      return {
        success: false,
        error: `Failed to load file from processor: ${fileResponse.statusText}`,
      };
    }

    const fileBuffer = Buffer.from(await fileResponse.arrayBuffer());
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
    
    // For non-image types (like PDFs), return as-is
    if (!mimeType.startsWith('image/') || mimeType === 'image/svg+xml') {
      return {
        success: true,
        visualContent: {
          mimeType,
          base64: fileBuffer.toString('base64'),
          sizeBytes: originalSize,
        },
      };
    }
    
    // Request optimization from processor service
    try {
      const response = await fetch(`${PROCESSOR_URL}/api/optimize/prepare-for-ai`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contentHash,
          provider: provider || 'openai',
          returnBase64: !providerSupportsUrls(provider),
        }),
      });
      
      if (!response.ok) {
        // Fallback to original if processor fails
        console.warn('Processor optimization failed, using original');
        return {
          success: true,
          visualContent: {
            mimeType,
            base64: fileBuffer.toString('base64'),
            sizeBytes: originalSize,
          },
        };
      }
      
      const result = await response.json();
      
      if (result.type === 'url') {
        // Provider supports URLs - return URL reference
        return {
          success: true,
          visualContent: {
            mimeType: 'image/jpeg', // Processor always returns JPEG for ai-chat preset
            url: `${PROCESSOR_URL}${result.url}`,
            sizeBytes: result.size,
          },
        };
      } else {
        // Provider needs base64
        return {
          success: true,
          visualContent: {
            mimeType: result.mimeType || 'image/jpeg',
            base64: result.data,
            sizeBytes: result.size,
          },
        };
      }
    } catch (processorError) {
      console.warn('Processor service unavailable, using original:', processorError);
      // Fallback to original if processor is unavailable
      return {
        success: true,
        visualContent: {
          mimeType,
          base64: fileBuffer.toString('base64'),
          sizeBytes: originalSize,
        },
      };
    }
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
  const { mimeType, base64, url } = visualContent;
  
  // If we have a URL, use it (for providers that support it)
  if (url) {
    return {
      type: 'image',
      mimeType,
      image: url, // Some providers accept URLs in the image field
    };
  }
  
  // Otherwise use base64
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
 * Upload and process a new image file
 * This is for new uploads that need to be sent to the processor
 */
export async function uploadAndProcessImage(
  file: Buffer,
  originalName: string,
  mimeType: string,
  pageId?: string
): Promise<{ contentHash: string; url: string }> {
  const formData = new FormData();
  const blob = new Blob([file], { type: mimeType });
  formData.append('file', blob, originalName);
  if (pageId) {
    formData.append('pageId', pageId);
  }
  
  const response = await fetch(`${PROCESSOR_URL}/api/upload/single`, {
    method: 'POST',
    body: formData,
  });
  
  if (!response.ok) {
    throw new Error('Failed to upload and process image');
  }
  
  const result = await response.json();
  
  // Return the URL for the optimized version
  return {
    contentHash: result.contentHash,
    url: `${PROCESSOR_URL}/cache/${result.contentHash}/ai-chat`,
  };
}