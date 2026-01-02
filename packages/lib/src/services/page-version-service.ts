import { db, pageVersions } from '@pagespace/db';
import { detectPageContentFormat, type PageContentFormat } from '../content/page-content-format';
import { writePageContent, type WritePageContentResult } from './page-content-store';
import { hashObject } from '../utils/hash-utils';
import type { ChangeGroupType } from '../monitoring/change-group';

/**
 * Compression metadata stored in pageVersions.metadata JSONB field.
 * This tracks how content was stored for version storage optimization.
 */
export interface CompressionMetadata {
  /** Whether the content was compressed */
  compressed: boolean;
  /** Original content size in bytes */
  originalSize: number;
  /** Stored size in bytes (may be smaller if compressed) */
  storedSize: number;
  /** Compression ratio (storedSize / originalSize), 1.0 if not compressed */
  compressionRatio: number;
}

export type PageVersionSource = 'manual' | 'auto' | 'pre_ai' | 'pre_restore' | 'restore' | 'system';
export type { ChangeGroupType };

export interface PageStateInput {
  title: string | null;
  contentRef: string | null;
  parentId: string | null;
  position: number;
  isTrashed: boolean;
  type: string;
  driveId: string;
  aiProvider?: string | null;
  aiModel?: string | null;
  systemPrompt?: string | null;
  enabledTools?: unknown;
  isPaginated?: boolean | null;
  includeDrivePrompt?: boolean | null;
  agentDefinition?: string | null;
  visibleToGlobalAssistant?: boolean | null;
  includePageTree?: boolean | null;
  pageTreeScope?: string | null;
}

export interface CreatePageVersionInput {
  pageId: string;
  driveId: string;
  createdBy?: string | null;
  source: PageVersionSource;
  label?: string;
  reason?: string;
  content: string;
  contentFormat?: PageContentFormat;
  pageRevision: number;
  stateHash: string;
  changeGroupId?: string;
  changeGroupType?: ChangeGroupType;
  metadata?: Record<string, unknown>;
}

export function computePageStateHash(input: PageStateInput): string {
  return hashObject(input);
}

/**
 * Result of creating a page version
 */
export interface CreatePageVersionResult {
  /** Version ID */
  id: string;
  /** Content reference (SHA-256 hash) */
  contentRef: string;
  /** Original content size in bytes */
  contentSize: number;
  /** Whether content was compressed */
  compressed: boolean;
  /** Stored size in bytes (may be smaller if compressed) */
  storedSize: number;
  /** Compression ratio (storedSize / originalSize), 1.0 if not compressed */
  compressionRatio: number;
}

/**
 * Creates a page version with content storage and optional compression.
 *
 * Content is automatically compressed when size >= 1KB (COMPRESSION_THRESHOLD_BYTES).
 * Compression metadata is stored in the metadata JSONB field for tracking storage optimization.
 *
 * @param input - Version input data including content
 * @param options - Optional transaction context
 * @returns Version ID, content reference, and compression details
 *
 * @example
 * ```typescript
 * const result = await createPageVersion({
 *   pageId: 'page123',
 *   driveId: 'drive456',
 *   source: 'auto',
 *   content: documentContent,
 *   pageRevision: 1,
 *   stateHash: 'abc123...',
 * });
 *
 * console.log(result.compressed); // true if content was compressed
 * console.log(result.compressionRatio); // e.g., 0.35 (65% reduction)
 * ```
 */
export async function createPageVersion(
  input: CreatePageVersionInput,
  options?: { tx?: typeof db }
): Promise<CreatePageVersionResult> {
  const format = input.contentFormat ?? detectPageContentFormat(input.content);
  const contentResult = await writePageContent(input.content, format);
  const database = options?.tx ?? db;

  // Build compression metadata to store in JSONB metadata field
  const compressionMetadata: CompressionMetadata = {
    compressed: contentResult.compressed,
    originalSize: contentResult.size,
    storedSize: contentResult.storedSize,
    compressionRatio: contentResult.compressionRatio,
  };

  // Merge compression metadata with any existing metadata
  const mergedMetadata: Record<string, unknown> = {
    ...input.metadata,
    compression: compressionMetadata,
  };

  const [created] = await database
    .insert(pageVersions)
    .values({
      pageId: input.pageId,
      driveId: input.driveId,
      createdBy: input.createdBy ?? null,
      source: input.source,
      label: input.label,
      reason: input.reason,
      changeGroupId: input.changeGroupId,
      changeGroupType: input.changeGroupType,
      contentRef: contentResult.ref,
      contentFormat: format,
      contentSize: contentResult.size,
      stateHash: input.stateHash,
      pageRevision: input.pageRevision,
      metadata: mergedMetadata,
    })
    .returning({ id: pageVersions.id });

  return {
    id: created.id,
    contentRef: contentResult.ref,
    contentSize: contentResult.size,
    compressed: contentResult.compressed,
    storedSize: contentResult.storedSize,
    compressionRatio: contentResult.compressionRatio,
  };
}
