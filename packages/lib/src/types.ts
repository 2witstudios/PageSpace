import { PageType, PermissionAction } from './enums';

export type ProcessingStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'visual';
export type ExtractionMethod = 'text' | 'ocr' | 'hybrid' | 'visual' | 'none';

export interface ExtractionMetadata {
  pageCount?: number;
  wordCount?: number;
  characterCount?: number;
  processingTimeMs?: number;
  extractionMethod?: ExtractionMethod;
  scribeVersion?: string;
  languages?: string[];
  confidence?: number;
}

export interface ExtractionResult {
  success: boolean;
  content: string;
  processingStatus: ProcessingStatus;
  extractionMethod?: ExtractionMethod;
  metadata?: ExtractionMetadata;
  error?: string;
  contentHash?: string;
}

export interface Page {
  id: string;
  title: string;
  type: PageType;
  content: any;
  position: number;
  isTrashed: boolean;
  createdAt: Date;
  updatedAt: Date;
  trashedAt: Date | null;
  driveId: string;
  parentId: string | null;
  originalParentId: string | null;
  isOwned?: boolean;
  accessLevel?: PermissionAction | null;
  // File-specific fields
  fileSize?: number;
  mimeType?: string;
  originalFileName?: string;
  filePath?: string;
  fileMetadata?: Record<string, any>;
  // Processing status fields
  processingStatus?: ProcessingStatus;
  processingError?: string;
  processedAt?: Date;
  extractionMethod?: ExtractionMethod;
  extractionMetadata?: ExtractionMetadata;
  contentHash?: string;
}

export interface Drive {
  id: string;
  name: string;
  slug: string;
  ownerId: string;
  isTrashed: boolean;
  trashedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  isOwned: boolean;
}