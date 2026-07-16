/**
 * Page-mutation planning.
 *
 * Pure computation of the next page state, revision counter, and content
 * hashes for a rollback page write — extracted from applyPageUpdateWithRevision
 * so every field's override/fallback branch is testable without a database. The
 * shell interprets the returned plan against the DB (the revision-guarded write,
 * mention sync, and version row). Also houses two small shared helpers the
 * handlers duplicated: restoreFields and pickConversationTable.
 */
import { channelMessages } from '@pagespace/db/schema/chat';
import { messages } from '@pagespace/db/schema/conversations';
import { chatMessages } from '@pagespace/db/schema/core';
import { computePageStateHash } from '@pagespace/lib/services/page-version-service';
import { hashWithPrefix } from '@pagespace/lib/utils/hash-utils';
import { detectPageContentFormat, type PageContentFormat } from '@pagespace/lib/content/page-content-format';

/** The current page fields read when planning a mutation. */
export interface CurrentPageForMutation {
  revision: number;
  content: string | null;
  title: string;
  parentId: string | null;
  position: number;
  isTrashed: boolean;
  type: string;
  driveId: string;
  aiProvider: string | null;
  aiModel: string | null;
  systemPrompt: string | null;
  enabledTools: unknown;
  isPaginated: boolean;
  includeDrivePrompt: boolean;
  agentDefinition: string | null;
  visibleToGlobalAssistant: boolean;
  includePageTree: boolean;
  pageTreeScope: string | null;
  userScopedAccess: boolean;
}

/** The resolved next state fed to computePageStateHash. */
export interface NextPageState {
  title: string;
  contentRef: string;
  parentId: string | null;
  position: number;
  isTrashed: boolean;
  type: string;
  driveId: string;
  aiProvider: string | null;
  aiModel: string | null;
  systemPrompt: string | null;
  enabledTools: unknown;
  isPaginated: boolean;
  includeDrivePrompt: boolean;
  agentDefinition: string | null;
  visibleToGlobalAssistant: boolean;
  includePageTree: boolean;
  pageTreeScope: string | null;
  userScopedAccess: boolean;
}

export interface PageMutationComputation {
  currentRevision: number;
  nextRevision: number;
  previousContent: string;
  nextContent: string;
  contentFormatBefore: PageContentFormat;
  contentFormatAfter: PageContentFormat;
  contentRefBefore: string;
  contentRefAfter: string;
  stateHashBefore: string;
  stateHashAfter: string;
  nextState: NextPageState;
}

/** Coerce an optional string-or-null update field, preserving explicit null. */
function resolveNullableString(value: unknown, fallback: string | null): string | null {
  if (value === undefined) return fallback;
  return value === null ? null : String(value);
}

/**
 * Compute the deterministic mutation plan (next revision, content, hashes, and
 * the resolved next state) for a page update. Pure — no DB access. Every
 * `updateData.X !== undefined` field takes the override value (coerced) or
 * falls back to the current page value.
 */
export function computePageMutation(
  currentPage: CurrentPageForMutation,
  updateData: Record<string, unknown>
): PageMutationComputation {
  const currentRevision = typeof currentPage.revision === 'number' ? currentPage.revision : 0;
  const nextRevision = currentRevision + 1;

  const previousContent = currentPage.content ?? '';
  const nextContent = updateData.content !== undefined
    ? String(updateData.content)
    : previousContent;
  const contentFormatBefore = detectPageContentFormat(previousContent);
  const contentFormatAfter = detectPageContentFormat(nextContent);
  const contentRefBefore = hashWithPrefix(contentFormatBefore, previousContent);
  const contentRefAfter = hashWithPrefix(contentFormatAfter, nextContent);

  const stateHashBefore = computePageStateHash({
    title: currentPage.title,
    contentRef: contentRefBefore,
    parentId: currentPage.parentId,
    position: currentPage.position,
    isTrashed: currentPage.isTrashed,
    type: currentPage.type,
    driveId: currentPage.driveId,
    aiProvider: currentPage.aiProvider,
    aiModel: currentPage.aiModel,
    systemPrompt: currentPage.systemPrompt,
    enabledTools: currentPage.enabledTools,
    isPaginated: currentPage.isPaginated,
    includeDrivePrompt: currentPage.includeDrivePrompt,
    agentDefinition: currentPage.agentDefinition,
    visibleToGlobalAssistant: currentPage.visibleToGlobalAssistant,
    includePageTree: currentPage.includePageTree,
    pageTreeScope: currentPage.pageTreeScope,
    userScopedAccess: currentPage.userScopedAccess,
  });

  const nextState: NextPageState = {
    title: updateData.title !== undefined ? String(updateData.title) : currentPage.title,
    contentRef: contentRefAfter,
    parentId: updateData.parentId !== undefined ? (updateData.parentId as string | null) : currentPage.parentId,
    position: updateData.position !== undefined ? Number(updateData.position) : currentPage.position,
    isTrashed: updateData.isTrashed !== undefined ? Boolean(updateData.isTrashed) : currentPage.isTrashed,
    type: updateData.type !== undefined ? String(updateData.type) : currentPage.type,
    driveId: currentPage.driveId,
    aiProvider: resolveNullableString(updateData.aiProvider, currentPage.aiProvider),
    aiModel: resolveNullableString(updateData.aiModel, currentPage.aiModel),
    systemPrompt: resolveNullableString(updateData.systemPrompt, currentPage.systemPrompt),
    enabledTools: updateData.enabledTools !== undefined ? updateData.enabledTools : currentPage.enabledTools,
    isPaginated: updateData.isPaginated !== undefined ? Boolean(updateData.isPaginated) : currentPage.isPaginated,
    includeDrivePrompt: updateData.includeDrivePrompt !== undefined ? Boolean(updateData.includeDrivePrompt) : currentPage.includeDrivePrompt,
    agentDefinition: resolveNullableString(updateData.agentDefinition, currentPage.agentDefinition),
    visibleToGlobalAssistant: updateData.visibleToGlobalAssistant !== undefined ? Boolean(updateData.visibleToGlobalAssistant) : currentPage.visibleToGlobalAssistant,
    includePageTree: updateData.includePageTree !== undefined ? Boolean(updateData.includePageTree) : currentPage.includePageTree,
    pageTreeScope: resolveNullableString(updateData.pageTreeScope, currentPage.pageTreeScope),
    userScopedAccess: updateData.userScopedAccess !== undefined ? Boolean(updateData.userScopedAccess) : currentPage.userScopedAccess,
  };

  const stateHashAfter = computePageStateHash(nextState);

  return {
    currentRevision,
    nextRevision,
    previousContent,
    nextContent,
    contentFormatBefore,
    contentFormatAfter,
    contentRefBefore,
    contentRefAfter,
    stateHashBefore,
    stateHashAfter,
    nextState,
  };
}

/**
 * Copy the named fields present in `source` into a fresh object. The single
 * replacement for the per-handler "for (field of FIELDS) if (field in prev)"
 * loops. Key presence — not value — decides inclusion (an explicit undefined is
 * copied), matching the original `in` checks.
 */
export function restoreFields(
  fields: readonly string[],
  source: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (!source) return result;
  for (const field of fields) {
    if (field in source) {
      result[field] = source[field];
    }
  }
  return result;
}

/** Message table plus the derived flags for a conversation. */
export interface ConversationTableSelection {
  table: typeof channelMessages | typeof messages | typeof chatMessages;
  isChannel: boolean;
  isGlobal: boolean;
  label: 'channel' | 'global' | 'page';
}

/**
 * Route a message activity to its backing table. Channel conversations use
 * channelMessages; a global conversation (or one with no page) uses messages;
 * everything else is a page conversation on chatMessages. Single replacement
 * for the three duplicated conversationType ternaries.
 */
export function pickConversationTable(params: {
  conversationType?: string;
  hasPageId: boolean;
}): ConversationTableSelection {
  const isChannel = params.conversationType === 'channel';
  const isGlobal = !isChannel && (!params.hasPageId || params.conversationType === 'global');
  const table = isChannel ? channelMessages : isGlobal ? messages : chatMessages;
  const label = isChannel ? 'channel' : isGlobal ? 'global' : 'page';
  return { table, isChannel, isGlobal, label };
}
