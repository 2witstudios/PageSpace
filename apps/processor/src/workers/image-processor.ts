import sharp from 'sharp';
import { contentStore } from '../server';
import { IMAGE_PRESETS, ImagePreset } from '../types';

/** Sanitize a value for safe logging - strips control characters and newlines */
function sanitizeLogValue(value: string): string {
  return String(value).replace(/[\x00-\x1f\x7f-\x9f\n\r]/g, '').slice(0, 200);
}

interface ImageJobData {
  contentHash: string;
  preset: string;
  fileId?: string;
}

export async function processImage(data: ImageJobData): Promise<any> {
  const { contentHash, preset: presetName } = data;
  
  // Check if already cached
  const exists = await contentStore.cacheExists(contentHash, presetName);
  if (exists) {
    console.log('Cache hit for %s/%s', sanitizeLogValue(contentHash), sanitizeLogValue(presetName));
    return {
      success: true,
      cached: true,
      url: await contentStore.getCacheUrl(contentHash, presetName)
    };
  }

  // Get preset configuration
  const preset = IMAGE_PRESETS[presetName];
  if (!preset) {
    throw new Error(`Unknown preset: ${presetName}`);
  }

  // Load original image
  const originalBuffer = await contentStore.getOriginal(contentHash);
  if (!originalBuffer) {
    throw new Error(`Original file not found: ${contentHash}`);
  }

  console.log('Processing image %s with preset %s', sanitizeLogValue(contentHash), sanitizeLogValue(presetName));

  try {
    // Process image with Sharp
    let pipeline = sharp(originalBuffer);

    // Get metadata to check dimensions
    const metadata = await pipeline.metadata();

    // Resize if needed
    if (metadata.width && metadata.width > preset.maxWidth) {
      pipeline = pipeline.resize(preset.maxWidth, preset.maxHeight, {
        fit: 'inside',
        withoutEnlargement: true
      });
    }

    // Convert format and set quality
    switch (preset.format) {
      case 'jpeg':
        pipeline = pipeline.jpeg({ 
          quality: preset.quality,
          progressive: true,
          mozjpeg: true // Better compression
        });
        break;
      case 'webp':
        pipeline = pipeline.webp({ 
          quality: preset.quality,
          effort: 4 // Balance between speed and compression
        });
        break;
      case 'png':
        pipeline = pipeline.png({ 
          quality: preset.quality,
          compressionLevel: 9,
          adaptiveFiltering: true
        });
        break;
    }

    // Auto-rotate based on EXIF
    pipeline = pipeline.rotate();

    // Process the image
    const processedBuffer = await pipeline.toBuffer();

    // Save to cache
    const mimeType = `image/${preset.format}`;
    await contentStore.saveCache(contentHash, presetName, processedBuffer, mimeType);

    const url = await contentStore.getCacheUrl(contentHash, presetName);

    console.log('Successfully processed %s/%s, size: %d bytes', sanitizeLogValue(contentHash), sanitizeLogValue(presetName), processedBuffer.length);

    return {
      success: true,
      cached: false,
      url,
      size: processedBuffer.length,
      originalSize: originalBuffer.length,
      compressionRatio: (processedBuffer.length / originalBuffer.length * 100).toFixed(1) + '%'
    };

  } catch (error) {
    console.error('Failed to process image %s/%s:', sanitizeLogValue(contentHash), sanitizeLogValue(presetName), error);
    throw error;
  }
}

// Batch optimize function for multiple presets
export async function optimizeImageForAllPresets(contentHash: string): Promise<any> {
  const results: Record<string, any> = {};
  
  // Process all standard presets in parallel
  const presets = ['ai-chat', 'ai-vision', 'thumbnail', 'preview'];
  
  await Promise.all(
    presets.map(async (preset) => {
      try {
        results[preset] = await processImage({ contentHash, preset });
      } catch (error) {
        results[preset] = { 
          success: false, 
          error: error instanceof Error ? error.message : 'Unknown error' 
        };
      }
    })
  );

  return results;
}

// Special function for AI vision processing
export async function prepareImageForAI(
  contentHash: string,
  maxSize: number = 20 * 1024 * 1024 // 20MB max for AI providers
): Promise<{ url?: string; base64?: string; size: number }> {
  // Try to use cached AI-optimized version first
  const cached = await contentStore.getCache(contentHash, 'ai-chat');
  
  if (cached && cached.length <= maxSize) {
    return {
      url: await contentStore.getCacheUrl(contentHash, 'ai-chat'),
      size: cached.length
    };
  }

  // If not cached or too large, process it
  const original = await contentStore.getOriginal(contentHash);
  if (!original) {
    throw new Error(`Original file not found: ${contentHash}`);
  }

  // If original is small enough and is already JPEG, use it directly
  const metadata = await sharp(original).metadata();
  if (original.length <= maxSize && metadata.format === 'jpeg') {
    return {
      url: await contentStore.getCacheUrl(contentHash, 'original'),
      size: original.length
    };
  }

  // Otherwise, optimize it
  await processImage({ contentHash, preset: 'ai-chat' });
  const optimized = await contentStore.getCache(contentHash, 'ai-chat');
  
  if (!optimized) {
    throw new Error('Failed to optimize image');
  }

  return {
    url: await contentStore.getCacheUrl(contentHash, 'ai-chat'),
    size: optimized.length
  };
}