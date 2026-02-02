import { PageType, PermissionAction } from './utils/enums';

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
  createdAt: string; // ISO8601 date string from API
  updatedAt: string; // ISO8601 date string from API
  revision?: number;
  stateHash?: string | null;
  trashedAt: string | null; // ISO8601 date string from API
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
  processedAt?: string; // ISO8601 date string from API
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
  trashedAt: string | null; // ISO8601 date string from API
  createdAt: string; // ISO8601 date string from API
  updatedAt: string; // ISO8601 date string from API
  isOwned: boolean;
  role?: 'OWNER' | 'ADMIN' | 'MEMBER';
}

// Inbox types for unified DM/Channel inbox
export interface InboxItem {
  id: string;
  type: 'dm' | 'channel';
  name: string;
  avatarUrl: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastMessageSender: string | null;
  unreadCount: number;
  driveId?: string;
  driveName?: string;
}

export interface InboxResponse {
  items: InboxItem[];
  pagination: {
    hasMore: boolean;
    nextCursor: string | null;
  };
}
