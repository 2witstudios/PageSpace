import { db, pageVersions } from '@pagespace/db';
import { detectPageContentFormat, type PageContentFormat } from '../content/page-content-format';
import { writePageContent } from './page-content-store';
import { hashObject } from '../utils/hash-utils';
import type { ChangeGroupType } from '../monitoring/change-group';

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

export async function createPageVersion(
  input: CreatePageVersionInput,
  options?: { tx?: typeof db }
): Promise<{ id: string; contentRef: string; contentSize: number }> {
  const format = input.contentFormat ?? detectPageContentFormat(input.content);
  const { ref, size } = await writePageContent(input.content, format);
  const database = options?.tx ?? db;

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
      contentRef: ref,
      contentFormat: format,
      contentSize: size,
      stateHash: input.stateHash,
      pageRevision: input.pageRevision,
      metadata: input.metadata,
    })
    .returning({ id: pageVersions.id });

  return { id: created.id, contentRef: ref, contentSize: size };
}
