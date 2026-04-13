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

// Job data payloads (what goes INTO each queue)
export interface IngestFileJobData {
  contentHash: string;
  fileId?: string;
  mimeType: string;
  originalName: string;
  detectedLabel?: string;
}

export interface ImageOptimizeJobData {
  contentHash: string;
  preset: string;
  fileId?: string;
}

export interface TextExtractJobData {
  contentHash: string;
  fileId: string;
  mimeType: string;
  originalName: string;
}

export interface OCRJobData {
  contentHash: string;
  fileId: string;
  language?: string;
  provider?: 'tesseract' | 'ai-vision';
}

// Discriminated union for addJob
export type JobDataMap = {
  'ingest-file': IngestFileJobData;
  'image-optimize': ImageOptimizeJobData;
  'text-extract': TextExtractJobData;
  'ocr-process': OCRJobData;
  'siem-delivery': Record<string, never>;
};

export type QueueName = keyof JobDataMap;

// Job results (what comes OUT of each worker)
export interface IngestResult {
  success: boolean;
  status: 'visual' | 'completed';
  textLength?: number;
}

export interface ImageProcessResult {
  success: boolean;
  cached: boolean;
  url?: string;
  size?: number;
  originalSize?: number;
  compressionRatio?: string;
  error?: string;
}

export interface TextExtractResult {
  success: boolean;
  text?: string;
  textLength?: number;
  metadata?: Record<string, unknown>;
  cached?: boolean;
  error?: string;
}

export interface OCRResult {
  success: boolean;
  cached: boolean;
  text?: string;
  textLength?: number;
  provider: string;
}

export type JobResult = IngestResult | ImageProcessResult | TextExtractResult | OCRResult;

// Queue status reporting
export interface QueueStats {
  active: number;
  pending: number;
  completed: number;
  failed: number;
}

export interface ProcessingJob {
  id: string;
  type: QueueName;
  fileId: string;
  contentHash: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  result?: JobResult;
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
