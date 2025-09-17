export interface ImagePreset {
  name: string;
  maxWidth: number;
  maxHeight?: number;
  quality: number;
  format: 'jpeg' | 'webp' | 'png';
}

export const IMAGE_PRESETS: Record<string, ImagePreset> = {
  'ai-chat': {
    name: 'ai-chat',
    maxWidth: 1920,
    quality: 85,
    format: 'jpeg'
  },
  'ai-vision': {
    name: 'ai-vision',
    maxWidth: 2048,
    quality: 90,
    format: 'jpeg'
  },
  'thumbnail': {
    name: 'thumbnail',
    maxWidth: 200,
    maxHeight: 200,
    quality: 80,
    format: 'webp'
  },
  'preview': {
    name: 'preview',
    maxWidth: 800,
    quality: 85,
    format: 'jpeg'
  }
};

export interface ProcessingJob {
  id: string;
  type: 'ingest-file' | 'image-optimize' | 'text-extract' | 'ocr-process';
  fileId: string;
  contentHash: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  result?: any;
  error?: string;
  createdAt: Date;
  completedAt?: Date;
}

export interface FileMetadata {
  id: string;
  originalName: string;
  mimeType: string;
  size: number;
  contentHash: string;
  storagePath: string;
  processedAt?: Date;
}

export interface CacheEntry {
  contentHash: string;
  preset: string;
  path: string;
  size: number;
  mimeType: string;
  createdAt: Date;
  lastAccessed: Date;
}
