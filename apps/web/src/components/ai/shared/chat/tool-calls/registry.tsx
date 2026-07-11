import React from 'react';

import { TASK_TOOL_NAMES } from '../useAggregatedTasks';
import { ASK_USER_TOOL_NAME } from '@/lib/ai/tools/ask-user-tools';
import { RichContentRenderer } from './RichContentRenderer';
import { RichDiffRenderer } from './RichDiffRenderer';
import { PageTreeRenderer, type TreeItem } from './PageTreeRenderer';
import { DriveListRenderer } from './DriveListRenderer';
import { ActionResultRenderer } from './ActionResultRenderer';
import { SearchResultsRenderer, type SearchResult } from './SearchResultsRenderer';
import { AgentListRenderer, type AgentInfo } from './AgentListRenderer';
import { ActivityRenderer, type ActivityItem } from './ActivityRenderer';
import { WebSearchRenderer, type WebSearchResult } from './WebSearchRenderer';
import { MemberListRenderer, type MemberInfo } from './MemberListRenderer';
import { SheetEditRenderer } from './SheetEditRenderer';
import { AgentConfigRenderer, type AgentConfigData } from './AgentConfigRenderer';
import { ModelListRenderer, type ModelListProvider } from './ModelListRenderer';
import { WebFetchRenderer } from './WebFetchRenderer';
import { TaskStatusRenderer } from './TaskStatusRenderer';
import { CalendarEventRenderer, type CalendarEventData } from './calendar/CalendarEventRenderer';
import { CalendarEventListRenderer } from './calendar/CalendarEventListRenderer';
import { CalendarAvailabilityRenderer, type FreeSlot } from './calendar/CalendarAvailabilityRenderer';
import { WorkflowListRenderer } from './workflow/WorkflowListRenderer';
import { WorkflowCard, type WorkflowData } from './workflow/WorkflowCard';
import { GeneratedImageRenderer } from './GeneratedImageRenderer';

/**
 * Tool-call renderer registry.
 *
 * Single source of truth mapping an AI tool name to the rich card shown inside
 * the chat tool dropdown. `ToolCallRenderer` dispatches through this map; the
 * coverage test (`__tests__/registry-coverage.test.ts`) asserts every tool in
 * `pageSpaceTools` is either registered here or in {@link SPECIAL_HANDLED_TOOLS},
 * so a newly added tool can't ship without a renderer.
 *
 * A renderer returns `null` to fall through to the generic success/JSON
 * fallback (used when the expected payload shape is absent, e.g. an error
 * result).
 */

export interface ToolRenderContext {
  toolName: string;
  parsedInput: Record<string, unknown> | null;
  /** Parsed tool output; guaranteed non-null when a registry renderer runs. */
  parsedOutput: Record<string, unknown>;
  /** Raw, unparsed output (used by the generic JSON fallback). */
  output: unknown;
  error?: string;
}

export type ToolRenderer = (ctx: ToolRenderContext) => React.ReactNode;

// Several tool families return their payload nested under `data`; others return
// it flat. Prefer the nested object when present.
const pickData = (output: Record<string, unknown>): Record<string, unknown> => {
  const data = output.data;
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : output;
};

const buildChannelTranscript = (channelMessages: unknown): string | null => {
  if (!Array.isArray(channelMessages) || channelMessages.length === 0) {
    return null;
  }

  const lines = channelMessages.flatMap((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      return [];
    }

    const message = entry as Record<string, unknown>;
    const lineNumber = typeof message.lineNumber === 'number' ? message.lineNumber : index + 1;
    const createdAt = typeof message.createdAt === 'string' ? message.createdAt : '';
    const senderName = typeof message.senderName === 'string' ? message.senderName : 'Unknown';
    const senderType = typeof message.senderType === 'string' ? message.senderType : 'user';
    const content = typeof message.content === 'string' ? message.content : '';

    const senderPrefix = senderType === 'agent'
      ? '[agent]'
      : senderType === 'global_assistant'
        ? '[assistant]'
        : '[user]';

    const timestamp = createdAt ? ` (${createdAt})` : '';
    return [`${lineNumber}→${senderPrefix} ${senderName}${timestamp}: ${content}`];
  });

  return lines.length > 0 ? lines.join('\n') : null;
};

const getSendChannelMessagePreview = (
  parsedInput: Record<string, unknown> | null,
  parsedOutput: Record<string, unknown>
): string | null => {
  const outputPreview = parsedOutput.messagePreview;
  if (typeof outputPreview === 'string' && outputPreview.trim().length > 0) {
    return outputPreview.trim();
  }

  const inputContent = parsedInput?.content;
  if (typeof inputContent === 'string' && inputContent.trim().length > 0) {
    return inputContent.trim();
  }

  return null;
};

// Convert the new list_pages structured pages array into a TreeItem tree.
const pagesArrayToTree = (pages: Array<{ id: string; title: string; type: string; path: string }>): TreeItem[] => {
  interface Entry { id: string; title: string; type: string; path: string; segments: string[] }
  const entries: Entry[] = pages.map(p => ({ ...p, segments: p.path.split('/').filter(Boolean) }));
  if (entries.length === 0) return [];

  // Start at the shallowest depth present so subfolder ls-results render flat,
  // not nested under a phantom parent node.
  const startDepth = Math.min(...entries.map(e => e.segments.length)) - 1;

  const build = (items: Entry[], depth: number): TreeItem[] => {
    const result: TreeItem[] = [];
    const seen = new Map<string, { entry?: Entry; children: Entry[] }>();
    for (const e of items) {
      if (e.segments.length <= depth) continue;
      const isDirect = e.segments.length === depth + 1;
      const key = isDirect ? e.id : e.segments[depth];
      if (!seen.has(key)) seen.set(key, { children: [] });
      const bucket = seen.get(key)!;
      if (isDirect) bucket.entry = e;
      else bucket.children.push(e);
    }
    for (const [, { entry, children }] of seen) {
      result.push({
        path: entry?.path ?? '',
        title: entry?.title ?? children[0]?.segments[depth] ?? 'Folder',
        type: entry?.type ?? 'FOLDER',
        pageId: entry?.id,
        children: build(children, depth + 1),
      });
    }
    return result;
  };

  return build(entries, startDepth);
};

// Parse the legacy list_pages "paths" string format into a tree structure.
// Path format: "📁 [FOLDER](Task) ID: xxx Path: /drive/folder"
const parsePathsToTree = (paths: string[]): TreeItem[] => {
  const pathRegex = /^\S+\s+\[([^\]]+)\](?:\s+\(Task\))?\s+ID:\s+(\S+)\s+Path:\s+(.+)$/;

  interface ParsedPage {
    type: string;
    pageId: string;
    fullPath: string;
    title: string;
    pathSegments: string[];
  }

  const parsedPages: ParsedPage[] = [];

  for (const path of paths) {
    const match = path.match(pathRegex);
    if (match) {
      const [, type, pageId, fullPath] = match;
      const segments = fullPath.split('/').filter(Boolean);
      const title = segments[segments.length - 1] || 'Untitled';
      parsedPages.push({ type, pageId, fullPath, title, pathSegments: segments });
    }
  }

  const buildTreeFromParsed = (pages: ParsedPage[], depth: number, parentPath: string[]): TreeItem[] => {
    const result: TreeItem[] = [];
    const seen = new Map<string, { page?: ParsedPage; children: ParsedPage[] }>();

    for (const page of pages) {
      if (page.pathSegments.length <= depth) continue;

      const currentSegment = page.pathSegments[depth];
      const isDirectChild = page.pathSegments.length === depth + 1;
      const mapKey = isDirectChild ? `${currentSegment}:${page.pageId}` : currentSegment;

      if (!seen.has(mapKey)) {
        seen.set(mapKey, { page: isDirectChild ? page : undefined, children: [] });
      }

      const entry = seen.get(mapKey)!;
      if (isDirectChild) {
        entry.page = page;
      } else {
        entry.children.push(page);
      }
    }

    for (const [, { page, children }] of seen) {
      const currentPath = [...parentPath, page?.title || children[0]?.pathSegments[depth] || 'unknown'];
      result.push({
        path: '/' + currentPath.join('/'),
        title: page?.title || children[0]?.pathSegments[depth] || 'Folder',
        type: page?.type ?? 'FOLDER',
        pageId: page?.pageId,
        children: buildTreeFromParsed(children, depth + 1, currentPath),
      });
    }

    return result;
  };

  return buildTreeFromParsed(parsedPages, 1, []);
};

/**
 * Tools handled outside this registry as full-width cards in the wrapper
 * (they replace the collapsible shell rather than render inside it). Listed so
 * the coverage test recognises them as intentionally rendered.
 */
export const SPECIAL_HANDLED_TOOLS: Set<string> = new Set<string>([
  ...TASK_TOOL_NAMES,
  'ask_agent',
  ASK_USER_TOOL_NAME,
]);

// pi uses lowercase tool names — these must match exactly what the pi coding agent sends.
export const CLI_TOOL_NAMES = ['read', 'write', 'edit', 'bash', 'find', 'grep', 'ls'] as const;
export const CLI_TOOL_SET = new Set<string>(CLI_TOOL_NAMES);

export const toolRenderers: Record<string, ToolRenderer> = {
  // === DRIVE TOOLS ===
  list_drives: ({ parsedOutput }) => {
    if (!parsedOutput.drives) return null;
    const drives = (parsedOutput.drives as Array<{ id: string; slug: string; title?: string; name?: string; description?: string; isPersonal?: boolean; memberCount?: number }>).map(d => ({
      id: d.id,
      name: d.name || d.title || 'Untitled',
      slug: d.slug,
      description: d.description,
      isPersonal: d.isPersonal,
      memberCount: d.memberCount,
    }));
    return <DriveListRenderer drives={drives} />;
  },

  create_drive: ({ parsedOutput }) => (
    <ActionResultRenderer
      actionType="create"
      success={parsedOutput.success !== false}
      title={(parsedOutput.name || parsedOutput.title) as string | undefined}
      oldTitle={parsedOutput.oldName as string | undefined}
      message={parsedOutput.message as string | undefined}
      errorMessage={parsedOutput.error as string | undefined}
    />
  ),

  rename_drive: ({ parsedOutput }) => (
    <ActionResultRenderer
      actionType="rename"
      success={parsedOutput.success !== false}
      title={(parsedOutput.name || parsedOutput.title) as string | undefined}
      oldTitle={parsedOutput.oldName as string | undefined}
      message={parsedOutput.message as string | undefined}
      errorMessage={parsedOutput.error as string | undefined}
    />
  ),

  update_drive_context: ({ parsedOutput }) => (
    <ActionResultRenderer
      actionType="update"
      success={parsedOutput.success !== false}
      title="Workspace Context"
      message={(parsedOutput.message as string | undefined) || 'Context updated successfully'}
      errorMessage={parsedOutput.error as string | undefined}
    />
  ),

  set_home_page: ({ parsedOutput }) => (
    <ActionResultRenderer
      actionType="update"
      success={parsedOutput.success !== false}
      title="Home Page"
      message={parsedOutput.message as string | undefined}
      errorMessage={parsedOutput.error as string | undefined}
    />
  ),

  // === PAGE READ TOOLS ===
  list_pages: ({ parsedOutput }) => {
    const driveName = (parsedOutput.driveName ?? parsedOutput.driveSlug) as string | undefined;
    const driveId = parsedOutput.driveId as string | undefined;
    // New structured format
    if (parsedOutput.pages && Array.isArray(parsedOutput.pages)) {
      const tree = pagesArrayToTree(parsedOutput.pages as Array<{ id: string; title: string; type: string; path: string }>);
      return <PageTreeRenderer tree={tree} driveName={driveName} driveId={driveId} />;
    }
    // Legacy: pre-built tree
    if (parsedOutput.tree) {
      return <PageTreeRenderer tree={parsedOutput.tree as TreeItem[]} driveName={driveName} driveId={driveId} />;
    }
    // Legacy: raw path strings
    if (parsedOutput.paths && Array.isArray(parsedOutput.paths)) {
      const tree = parsePathsToTree(parsedOutput.paths as string[]);
      return <PageTreeRenderer tree={tree} driveName={driveName} driveId={driveId} />;
    }
    return null;
  },

  list_trash: ({ parsedOutput }) => {
    if (!parsedOutput.tree) return null;
    return (
      <PageTreeRenderer
        tree={parsedOutput.tree as TreeItem[]}
        driveName={parsedOutput.driveName as string | undefined}
        driveId={parsedOutput.driveId as string | undefined}
        title="Trash"
      />
    );
  },

  read_page: ({ parsedOutput }) => {
    const directContentValue = parsedOutput.rawContent ?? parsedOutput.content;
    const directContent = typeof directContentValue === 'string' && directContentValue.length > 0
      ? directContentValue
      : undefined;
    const channelTranscript = buildChannelTranscript(parsedOutput.channelMessages);
    const hasChannelMessagesArray = Array.isArray(parsedOutput.channelMessages);
    const content = directContent ?? channelTranscript ?? (hasChannelMessagesArray ? 'Channel has no messages yet.' : undefined);

    if (content === undefined) return null;
    return (
      <RichContentRenderer
        title={(parsedOutput.title as string | undefined) || 'Document'}
        content={content}
        pageId={parsedOutput.pageId as string | undefined}
        pageType={parsedOutput.type as string | undefined}
      />
    );
  },

  list_conversations: ({ parsedOutput }) => {
    if (!parsedOutput.conversations) return null;
    const conversations = parsedOutput.conversations as Array<{ conversationId: string; title?: string; firstMessagePreview?: string; messageCount?: number }>;
    return (
      <PageTreeRenderer
        tree={conversations.map(c => ({
          path: c.conversationId,
          title: c.title || c.firstMessagePreview?.slice(0, 40) || `Conversation ${c.conversationId?.slice(0, 8) ?? ''}`,
          type: 'AI_CHAT',
          pageId: c.conversationId,
          children: [],
        }))}
        title="Conversations"
      />
    );
  },

  read_conversation: ({ parsedOutput }) => {
    if (!parsedOutput.content) return null;
    return (
      <RichContentRenderer
        title={(parsedOutput.title as string | undefined) || 'Conversation'}
        content={parsedOutput.content as string}
        pageId={parsedOutput.pageId as string | undefined}
        pageType="AI_CHAT"
      />
    );
  },

  // === PAGE WRITE TOOLS ===
  insert_content: ({ parsedOutput }) => {
    if (parsedOutput.success && typeof parsedOutput.oldContent === 'string' && typeof parsedOutput.newContent === 'string') {
      return (
        <RichDiffRenderer
          title={(parsedOutput.title as string | undefined) || 'Document'}
          oldContent={parsedOutput.oldContent}
          newContent={parsedOutput.newContent}
          pageId={parsedOutput.pageId as string | undefined}
          changeSummary={parsedOutput.message as string | undefined}
        />
      );
    }
    return (
      <ActionResultRenderer
        actionType="update"
        success={parsedOutput.success !== false}
        title={parsedOutput.title as string | undefined}
        pageId={parsedOutput.pageId as string | undefined}
        message={parsedOutput.message as string | undefined}
        errorMessage={parsedOutput.error as string | undefined}
      />
    );
  },

  replace_lines: ({ parsedOutput }) => {
    if (parsedOutput.success && parsedOutput.oldContent && parsedOutput.newContent) {
      return (
        <RichDiffRenderer
          title={(parsedOutput.title as string | undefined) || 'Document'}
          oldContent={parsedOutput.oldContent as string}
          newContent={parsedOutput.newContent as string}
          pageId={parsedOutput.pageId as string | undefined}
          changeSummary={parsedOutput.summary as string | undefined}
        />
      );
    }
    if (parsedOutput.success && parsedOutput.newContent) {
      return (
        <RichContentRenderer
          title={(parsedOutput.title as string | undefined) || 'Document'}
          content={parsedOutput.newContent as string}
          pageId={parsedOutput.pageId as string | undefined}
        />
      );
    }
    return (
      <ActionResultRenderer
        actionType="update"
        success={parsedOutput.success !== false}
        title={parsedOutput.title as string | undefined}
        pageId={parsedOutput.pageId as string | undefined}
        pageType={parsedOutput.type as string | undefined}
        errorMessage={parsedOutput.error as string | undefined}
      />
    );
  },

  create_page: ({ parsedOutput }) => (
    <ActionResultRenderer
      actionType="create"
      success={parsedOutput.success !== false}
      title={parsedOutput.title as string | undefined}
      pageId={parsedOutput.pageId as string | undefined}
      driveId={parsedOutput.driveId as string | undefined}
      pageType={parsedOutput.type as string | undefined}
      message={parsedOutput.message as string | undefined}
      errorMessage={parsedOutput.error as string | undefined}
    />
  ),

  rename_page: ({ parsedOutput }) => (
    <ActionResultRenderer
      actionType="rename"
      success={parsedOutput.success !== false}
      title={(parsedOutput.newTitle || parsedOutput.title) as string | undefined}
      oldTitle={parsedOutput.oldTitle as string | undefined}
      pageId={parsedOutput.pageId as string | undefined}
      driveId={parsedOutput.driveId as string | undefined}
      pageType={parsedOutput.type as string | undefined}
      errorMessage={parsedOutput.error as string | undefined}
    />
  ),

  trash_page: ({ parsedOutput }) => (
    <ActionResultRenderer
      actionType="trash"
      success={parsedOutput.success !== false}
      title={(parsedOutput.title || parsedOutput.name) as string | undefined}
      pageType={parsedOutput.pageType as string | undefined}
      message={parsedOutput.message as string | undefined}
      errorMessage={parsedOutput.error as string | undefined}
    />
  ),

  trash_drive: ({ parsedOutput }) => (
    <ActionResultRenderer
      actionType="trash"
      success={parsedOutput.success !== false}
      title={(parsedOutput.title || parsedOutput.name) as string | undefined}
      pageType={parsedOutput.pageType as string | undefined}
      message={parsedOutput.message as string | undefined}
      errorMessage={parsedOutput.error as string | undefined}
    />
  ),

  restore_page: ({ parsedOutput }) => (
    <ActionResultRenderer
      actionType="restore"
      success={parsedOutput.success !== false}
      title={(parsedOutput.title || parsedOutput.name) as string | undefined}
      pageId={parsedOutput.pageId as string | undefined}
      driveId={parsedOutput.driveId as string | undefined}
      pageType={parsedOutput.pageType as string | undefined}
      message={parsedOutput.message as string | undefined}
      errorMessage={parsedOutput.error as string | undefined}
    />
  ),

  restore_drive: ({ parsedOutput }) => (
    <ActionResultRenderer
      actionType="restore"
      success={parsedOutput.success !== false}
      title={(parsedOutput.title || parsedOutput.name) as string | undefined}
      pageId={parsedOutput.pageId as string | undefined}
      driveId={parsedOutput.driveId as string | undefined}
      pageType={parsedOutput.pageType as string | undefined}
      message={parsedOutput.message as string | undefined}
      errorMessage={parsedOutput.error as string | undefined}
    />
  ),

  move_page: ({ parsedOutput }) => (
    <ActionResultRenderer
      actionType="move"
      success={parsedOutput.success !== false}
      title={parsedOutput.title as string | undefined}
      pageId={parsedOutput.pageId as string | undefined}
      driveId={parsedOutput.driveId as string | undefined}
      pageType={parsedOutput.type as string | undefined}
      oldParent={parsedOutput.oldParentTitle as string | undefined}
      newParent={parsedOutput.newParentTitle as string | undefined}
      errorMessage={parsedOutput.error as string | undefined}
    />
  ),

  edit_sheet_cells: ({ parsedInput, parsedOutput }) => {
    if (parsedOutput.success === false) return null;
    return (
      <SheetEditRenderer
        inputCells={parsedInput?.cells as Array<{ address: string; value?: string }> | undefined}
        resultCells={parsedOutput.updatedCells as Array<{ address: string; type?: string }> | undefined}
        title={(parsedOutput.title as string | undefined) || 'Sheet'}
        pageId={parsedOutput.pageId as string | undefined}
        driveId={parsedOutput.driveId as string | undefined}
        cellsUpdated={parsedOutput.cellsUpdated as number | undefined}
      />
    );
  },

  // === FORM TOOLS ===
  provision_form_target: ({ parsedOutput }) => (
    <ActionResultRenderer
      actionType="create"
      success={parsedOutput.success !== false}
      title="Form target"
      pageId={parsedOutput.pageId as string | undefined}
      message={parsedOutput.message as string | undefined}
      errorMessage={parsedOutput.error as string | undefined}
    />
  ),

  update_form_target_status: ({ parsedOutput }) => (
    <ActionResultRenderer
      actionType="update"
      success={parsedOutput.success !== false}
      title="Form target"
      pageId={parsedOutput.pageId as string | undefined}
      message={parsedOutput.status ? `Status: ${parsedOutput.status as string}` : undefined}
      errorMessage={parsedOutput.error as string | undefined}
    />
  ),

  // === CHANNEL TOOLS ===
  send_channel_message: ({ parsedInput, parsedOutput }) => {
    const messagePreview = getSendChannelMessagePreview(parsedInput, parsedOutput);
    const channelTitle = parsedOutput.channelTitle;
    const previewTitle = typeof channelTitle === 'string' && channelTitle.length > 0
      ? `Message Preview · #${channelTitle}`
      : 'Message Preview';

    return (
      <div>
        <ActionResultRenderer
          actionType="update"
          success={parsedOutput.success !== false}
          title={channelTitle as string | undefined}
          pageId={parsedOutput.channelId as string | undefined}
          pageType="CHANNEL"
          message={(parsedOutput.summary || parsedOutput.message) as string | undefined}
          errorMessage={parsedOutput.error as string | undefined}
        />
        {messagePreview && (
          <RichContentRenderer
            title={previewTitle}
            content={messagePreview}
            pageId={parsedOutput.channelId as string | undefined}
            pageType="CHANNEL"
            maxHeight={220}
          />
        )}
      </div>
    );
  },

  delete_channel_message: ({ parsedOutput }) => (
    <ActionResultRenderer
      actionType="delete"
      success={parsedOutput.success !== false}
      title={parsedOutput.channelTitle as string | undefined}
      pageType="CHANNEL"
      message={parsedOutput.message as string | undefined}
      errorMessage={parsedOutput.error as string | undefined}
    />
  ),

  // === SEARCH TOOLS ===
  regex_search: ({ parsedInput, parsedOutput }) => {
    if (!parsedOutput.results) return null;
    return (
      <SearchResultsRenderer
        results={parsedOutput.results as SearchResult[]}
        query={parsedInput?.pattern as string}
        searchType="regex"
        totalMatches={parsedOutput.totalMatches as number | undefined}
      />
    );
  },

  glob_search: ({ parsedInput, parsedOutput }) => {
    if (!parsedOutput.results) return null;
    return (
      <SearchResultsRenderer
        results={parsedOutput.results as SearchResult[]}
        query={parsedInput?.pattern as string}
        searchType="glob"
      />
    );
  },

  multi_drive_search: ({ parsedInput, parsedOutput }) => {
    if (!parsedOutput.results) return null;
    return (
      <SearchResultsRenderer
        results={parsedOutput.results as SearchResult[]}
        query={(parsedInput?.pattern || parsedInput?.query) as string}
        searchType="multi-drive"
        totalMatches={parsedOutput.totalMatches as number | undefined}
      />
    );
  },

  // === MEMBER TOOLS ===
  list_drive_members: ({ parsedOutput }) => {
    if (!Array.isArray(parsedOutput.members)) return null;
    const driveName = (parsedOutput.stats as { driveName?: string } | undefined)?.driveName;
    return (
      <MemberListRenderer
        members={parsedOutput.members as MemberInfo[]}
        title={driveName ? `Members · ${driveName}` : 'Members'}
      />
    );
  },

  list_collaborators: ({ parsedOutput }) => {
    if (!Array.isArray(parsedOutput.collaborators)) return null;
    return <MemberListRenderer members={parsedOutput.collaborators as MemberInfo[]} title="Collaborators" />;
  },

  // === ROLE MANAGEMENT TOOLS ===
  list_drive_roles: ({ parsedOutput }) => {
    if (!Array.isArray(parsedOutput.roles)) return null;
    const roles = parsedOutput.roles as Array<{ name: string; description?: string | null; driveWidePermissions?: { canView: boolean; canEdit: boolean; canShare: boolean } | null }>;
    const driveName = (parsedOutput.stats as { driveName?: string } | undefined)?.driveName;
    const content = roles.length
      ? roles.map((r) => {
          const dwp = r.driveWidePermissions;
          const scope = dwp ? ` (drive-wide: ${[dwp.canView && 'view', dwp.canEdit && 'edit', dwp.canShare && 'share'].filter(Boolean).join('/') || 'none'})` : '';
          return `• ${r.name}${scope}${r.description ? ` — ${r.description}` : ''}`;
        }).join('\n')
      : 'No custom roles yet';
    return <RichContentRenderer title={driveName ? `Roles · ${driveName}` : 'Roles'} content={content} />;
  },

  get_drive_role: ({ parsedOutput }) => {
    const role = parsedOutput.role as { name: string; description?: string | null; driveWidePermissions?: { canView: boolean; canEdit: boolean; canShare: boolean } | null; permissions?: Record<string, unknown> } | undefined;
    if (!role) return null;
    const dwp = role.driveWidePermissions;
    const lines = [
      role.description ? `${role.description}` : null,
      dwp ? `Drive-wide: ${[dwp.canView && 'view', dwp.canEdit && 'edit', dwp.canShare && 'share'].filter(Boolean).join('/') || 'none'}` : 'Drive-wide: not set',
      `Per-page grants: ${Object.keys(role.permissions ?? {}).length}`,
    ].filter(Boolean).join('\n');
    return <RichContentRenderer title={`Role · ${role.name}`} content={lines} />;
  },

  create_drive_role: ({ parsedOutput }) => (
    <ActionResultRenderer
      actionType="create"
      success={parsedOutput.success !== false}
      title={(parsedOutput.role as { name?: string } | undefined)?.name ?? 'Role'}
      message={parsedOutput.summary as string | undefined}
      errorMessage={parsedOutput.error as string | undefined}
    />
  ),

  update_drive_role: ({ parsedOutput }) => (
    <ActionResultRenderer
      actionType="update"
      success={parsedOutput.success !== false}
      title={(parsedOutput.role as { name?: string } | undefined)?.name ?? 'Role'}
      message={parsedOutput.summary as string | undefined}
      errorMessage={parsedOutput.error as string | undefined}
    />
  ),

  delete_drive_role: ({ parsedOutput }) => (
    <ActionResultRenderer
      actionType="delete"
      success={parsedOutput.success !== false}
      title="Role"
      message={parsedOutput.summary as string | undefined}
      errorMessage={parsedOutput.error as string | undefined}
    />
  ),

  set_role_page_permissions: ({ parsedOutput }) => (
    <ActionResultRenderer
      actionType="update"
      success={parsedOutput.success !== false}
      title="Role Page Permissions"
      message={parsedOutput.summary as string | undefined}
      errorMessage={parsedOutput.error as string | undefined}
    />
  ),

  set_role_drive_wide_permissions: ({ parsedOutput }) => (
    <ActionResultRenderer
      actionType="update"
      success={parsedOutput.success !== false}
      title="Role Drive-Wide Permissions"
      message={parsedOutput.summary as string | undefined}
      errorMessage={parsedOutput.error as string | undefined}
    />
  ),

  remove_role_page_permissions: ({ parsedOutput }) => (
    <ActionResultRenderer
      actionType="remove"
      success={parsedOutput.success !== false}
      title="Role Page Permissions"
      message={parsedOutput.summary as string | undefined}
      errorMessage={parsedOutput.error as string | undefined}
    />
  ),

  // === AGENT TOOLS ===
  list_agents: ({ parsedOutput }) => {
    if (!parsedOutput.agents) return null;
    return <AgentListRenderer agents={parsedOutput.agents as AgentInfo[]} />;
  },

  multi_drive_list_agents: ({ parsedOutput }) => {
    if (!parsedOutput.agents) return null;
    return <AgentListRenderer agents={parsedOutput.agents as AgentInfo[]} isMultiDrive />;
  },

  list_models: ({ parsedOutput }) => {
    if (!Array.isArray(parsedOutput.providers)) return null;
    return <ModelListRenderer providers={parsedOutput.providers as ModelListProvider[]} />;
  },

  update_agent_config: ({ parsedOutput }) => {
    if (parsedOutput.success === false) return null;
    return (
      <AgentConfigRenderer
        title={(parsedOutput.title as string | undefined) || 'Agent'}
        updatedFields={parsedOutput.updatedFields as string[] | undefined}
        config={parsedOutput.agentConfig as AgentConfigData | undefined}
        message={parsedOutput.message as string | undefined}
        pageId={parsedOutput.id as string | undefined}
      />
    );
  },

  // === WEB ===
  web_search: ({ parsedInput, parsedOutput }) => {
    if (!parsedOutput.results) return null;
    return (
      <WebSearchRenderer
        results={parsedOutput.results as WebSearchResult[]}
        query={parsedInput?.query as string}
      />
    );
  },

  web_fetch: ({ parsedInput, parsedOutput }) => {
    if (parsedOutput.success === false) return null;
    const url = (parsedOutput.url as string | undefined) ?? (parsedInput?.url as string | undefined);
    if (!url) return null;
    return (
      <WebFetchRenderer
        url={url}
        content={parsedOutput.content as string | undefined}
        contentLength={parsedOutput.contentLength as number | undefined}
        truncated={Boolean(parsedOutput.truncated)}
      />
    );
  },

  // === IMAGE GENERATION ===
  generate_image: ({ parsedInput, parsedOutput }) => {
    if (parsedOutput.success === false) return null;
    const viewUrl = parsedOutput.viewUrl as string | undefined;
    if (!viewUrl) return null;
    return (
      <GeneratedImageRenderer
        data={{
          viewUrl,
          title: parsedOutput.title as string | undefined,
          prompt: (parsedOutput.prompt as string | undefined) ?? (parsedInput?.prompt as string | undefined),
        }}
      />
    );
  },

  // === ACTIVITY ===
  get_activity: ({ parsedOutput }) => {
    if (parsedOutput.activities) {
      return (
        <ActivityRenderer
          activities={parsedOutput.activities as ActivityItem[]}
          period={parsedOutput.period as string | undefined}
        />
      );
    }
    if (parsedOutput.drives && Array.isArray(parsedOutput.drives)) {
      const actors = (parsedOutput.actors || []) as Array<{ email: string; name: string | null; isYou: boolean; count: number }>;
      const driveGroups = parsedOutput.drives as Array<{
        drive: { id: string; name: string; slug: string; context: string | null };
        activities: Array<{
          id: string;
          ts: string;
          op: string;
          res: string;
          title: string | null;
          pageId: string | null;
          actor: number;
          ai?: string;
          fields?: string[];
          delta?: Record<string, unknown>;
        }>;
        stats: { total: number; byOp: Record<string, number>; aiCount: number };
      }>;

      const opToAction = (op: string): 'created' | 'updated' | 'deleted' | 'restored' | 'moved' | 'commented' | 'renamed' => {
        switch (op) {
          case 'create': return 'created';
          case 'update': return 'updated';
          case 'delete':
          case 'trash': return 'deleted';
          case 'restore': return 'restored';
          case 'move':
          case 'reorder': return 'moved';
          case 'rename': return 'renamed';
          default: return 'updated';
        }
      };

      const flatActivities: ActivityItem[] = [];
      for (const group of driveGroups) {
        for (const activity of group.activities) {
          const actor = actors[activity.actor];
          flatActivities.push({
            id: activity.id,
            action: opToAction(activity.op),
            pageId: activity.pageId || undefined,
            pageTitle: activity.title || undefined,
            pageType: activity.res === 'page' ? undefined : activity.res,
            driveId: group.drive.id,
            driveName: group.drive.name,
            actorName: actor?.name || actor?.email || undefined,
            timestamp: activity.ts,
            summary: activity.ai ? `AI-generated (${activity.ai})` : undefined,
          });
        }
      }

      flatActivities.sort((a, b) => {
        const timeA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const timeB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return timeB - timeA;
      });

      const meta = parsedOutput.meta as { window?: string } | undefined;
      const period = meta?.window ? `Last ${meta.window}` : undefined;

      return <ActivityRenderer activities={flatActivities} period={period} />;
    }
    return null;
  },

  // === TASK TOOLS ===
  get_assigned_tasks: ({ parsedOutput }) => {
    if (!parsedOutput.tasks) return null;
    const tasks = parsedOutput.tasks as Array<{ id: string; title: string; status?: string; pageId?: string }>;
    return (
      <PageTreeRenderer
        tree={tasks.map(t => ({
          path: t.id,
          title: `${t.status === 'completed' ? '[Done] ' : ''}${t.title}`,
          type: 'TASK_LIST',
          pageId: t.pageId,
          children: [],
        }))}
        title="Assigned Tasks"
      />
    );
  },

  create_task_status: ({ parsedOutput }) => {
    if (parsedOutput.error && !parsedOutput.slug) {
      return (
        <ActionResultRenderer
          actionType="create"
          success={false}
          title="Status"
          errorMessage={parsedOutput.error as string}
        />
      );
    }
    if (!parsedOutput.name) return null;
    return (
      <TaskStatusRenderer
        name={parsedOutput.name as string}
        slug={parsedOutput.slug as string | undefined}
        group={parsedOutput.group as string | undefined}
        color={parsedOutput.color as string | undefined}
        message={parsedOutput.message as string | undefined}
      />
    );
  },

  // === CALENDAR (READ) ===
  list_calendar_events: ({ parsedOutput }) => {
    const events = pickData(parsedOutput).events;
    if (!Array.isArray(events)) return null;
    return <CalendarEventListRenderer events={events as CalendarEventData[]} />;
  },

  get_calendar_event: ({ parsedOutput }) => {
    const event = pickData(parsedOutput).event;
    if (!event || typeof event !== 'object') return null;
    return <CalendarEventRenderer event={event as unknown as CalendarEventData} />;
  },

  check_calendar_availability: ({ parsedOutput }) => {
    const data = pickData(parsedOutput);
    const freeSlots = data.freeSlots;
    if (!Array.isArray(freeSlots)) return null;
    return <CalendarAvailabilityRenderer freeSlots={freeSlots as FreeSlot[]} hasMore={Boolean(data.hasMore)} />;
  },

  // === CALENDAR (WRITE) ===
  create_calendar_event: ({ parsedOutput }) => {
    if (parsedOutput.success === false) return null;
    const data = pickData(parsedOutput);
    if (!data.title) return null;
    return <CalendarEventRenderer event={data as unknown as CalendarEventData} actionLabel="Created" />;
  },

  update_calendar_event: ({ parsedOutput }) => {
    if (parsedOutput.success === false) return null;
    const data = pickData(parsedOutput);
    if (!data.title) return null;
    return <CalendarEventRenderer event={data as unknown as CalendarEventData} actionLabel="Updated" />;
  },

  delete_calendar_event: ({ parsedOutput }) => {
    const data = pickData(parsedOutput);
    return (
      <ActionResultRenderer
        actionType="delete"
        success={parsedOutput.success !== false}
        title={data.title as string | undefined}
        message={parsedOutput.summary as string | undefined}
        errorMessage={parsedOutput.error as string | undefined}
      />
    );
  },

  rsvp_calendar_event: ({ parsedOutput }) => {
    const data = pickData(parsedOutput);
    const status = data.status as string | undefined;
    return (
      <ActionResultRenderer
        actionType="rsvp"
        success={parsedOutput.success !== false}
        title={data.eventTitle as string | undefined}
        message={status ? `Responded ${status}` : (parsedOutput.summary as string | undefined)}
        errorMessage={parsedOutput.error as string | undefined}
      />
    );
  },

  invite_calendar_attendees: ({ parsedOutput }) => {
    const data = pickData(parsedOutput);
    return (
      <ActionResultRenderer
        actionType="invite"
        success={parsedOutput.success !== false}
        title={data.eventTitle as string | undefined}
        message={parsedOutput.summary as string | undefined}
        errorMessage={parsedOutput.error as string | undefined}
      />
    );
  },

  remove_calendar_attendee: ({ parsedOutput }) => {
    const data = pickData(parsedOutput);
    return (
      <ActionResultRenderer
        actionType="remove"
        success={parsedOutput.success !== false}
        title={data.eventTitle as string | undefined}
        message={parsedOutput.summary as string | undefined}
        errorMessage={parsedOutput.error as string | undefined}
      />
    );
  },

  list_event_drives: ({ parsedOutput }) => (
    <ActionResultRenderer
      actionType="update"
      success={parsedOutput.success !== false}
      message={parsedOutput.summary as string | undefined}
      errorMessage={parsedOutput.error as string | undefined}
    />
  ),

  share_event_with_drive: ({ parsedOutput }) => (
    <ActionResultRenderer
      actionType="create"
      success={parsedOutput.success !== false}
      message={parsedOutput.summary as string | undefined}
      errorMessage={parsedOutput.error as string | undefined}
    />
  ),

  unshare_event_from_drive: ({ parsedOutput }) => (
    <ActionResultRenderer
      actionType="delete"
      success={parsedOutput.success !== false}
      message={parsedOutput.summary as string | undefined}
      errorMessage={parsedOutput.error as string | undefined}
    />
  ),

  // === COMMAND TOOLS ===
  create_command: ({ parsedOutput }) => (
    <ActionResultRenderer
      actionType="create"
      success={parsedOutput.success !== false}
      title={typeof parsedOutput.trigger === 'string' ? `/${parsedOutput.trigger}` : undefined}
      message={parsedOutput.message as string | undefined}
      errorMessage={parsedOutput.error as string | undefined}
    />
  ),

  update_command: ({ parsedOutput }) => (
    <ActionResultRenderer
      actionType="update"
      success={parsedOutput.success !== false}
      title={typeof parsedOutput.trigger === 'string' ? `/${parsedOutput.trigger}` : undefined}
      message={parsedOutput.message as string | undefined}
      errorMessage={parsedOutput.error as string | undefined}
    />
  ),

  delete_command: ({ parsedOutput }) => (
    <ActionResultRenderer
      actionType="delete"
      success={parsedOutput.success !== false}
      title={typeof parsedOutput.trigger === 'string' ? `/${parsedOutput.trigger}` : undefined}
      message={parsedOutput.message as string | undefined}
      errorMessage={parsedOutput.error as string | undefined}
    />
  ),

  list_commands: ({ parsedOutput }) => {
    const cmds = parsedOutput.commands;
    if (!Array.isArray(cmds) || cmds.length === 0) return null;
    return (
      <PageTreeRenderer
        tree={(cmds as Array<{ id: string; trigger: string; description: string; scope: string; enabled?: boolean }>).map((c) => ({
          path: `/${c.trigger}`,
          title: `/${c.trigger}`,
          type: 'DOCUMENT',
          pageId: c.id,
          children: [],
        }))}
        title="Commands"
      />
    );
  },


  // === WORKFLOWS ===
  list_workflows: ({ parsedOutput }) => {
    if (!Array.isArray(parsedOutput.workflows)) return null;
    return <WorkflowListRenderer workflows={parsedOutput.workflows as WorkflowData[]} />;
  },

  create_workflow: ({ parsedInput, parsedOutput }) => {
    if (parsedOutput.success === false || !parsedOutput.workflowId) return null;
    const trigger = parsedInput?.agentTrigger as { agentPageId?: string } | undefined;
    const workflow: WorkflowData = {
      ...(parsedOutput as unknown as WorkflowData),
      agentPageId: trigger?.agentPageId,
      driveId: parsedInput?.driveId as string | undefined,
    };
    return <WorkflowCard workflow={workflow} />;
  },

  update_workflow: ({ parsedInput, parsedOutput }) => {
    if (parsedOutput.success === false || !parsedOutput.workflowId) return null;
    const trigger = parsedInput?.agentTrigger as { agentPageId?: string } | undefined;
    const workflow: WorkflowData = {
      ...(parsedOutput as unknown as WorkflowData),
      agentPageId: trigger?.agentPageId,
    };
    return <WorkflowCard workflow={workflow} />;
  },

  delete_workflow: ({ parsedOutput }) => (
    <ActionResultRenderer
      actionType="delete"
      success={parsedOutput.success !== false}
      title="Workflow"
      message={parsedOutput.summary as string | undefined}
      errorMessage={parsedOutput.error as string | undefined}
    />
  ),

  // === TRIGGER TOOLS ===
  set_calendar_trigger: ({ parsedOutput }) => (
    <ActionResultRenderer
      actionType="update"
      success={parsedOutput.success !== false}
      title="Calendar Trigger"
      message={(parsedOutput.summary || parsedOutput.message) as string | undefined}
      errorMessage={parsedOutput.error as string | undefined}
    />
  ),

  delete_calendar_trigger: ({ parsedOutput }) => (
    <ActionResultRenderer
      actionType="delete"
      success={parsedOutput.success !== false}
      title="Calendar Trigger"
      message={(parsedOutput.summary || parsedOutput.message) as string | undefined}
      errorMessage={parsedOutput.error as string | undefined}
    />
  ),

  set_task_trigger: ({ parsedOutput }) => (
    <ActionResultRenderer
      actionType="update"
      success={parsedOutput.success !== false}
      title="Task Trigger"
      message={(parsedOutput.summary || parsedOutput.message) as string | undefined}
      errorMessage={parsedOutput.error as string | undefined}
    />
  ),

  delete_task_trigger: ({ parsedOutput }) => (
    <ActionResultRenderer
      actionType="delete"
      success={parsedOutput.success !== false}
      title="Task Trigger"
      message={(parsedOutput.summary || parsedOutput.message) as string | undefined}
      errorMessage={parsedOutput.error as string | undefined}
    />
  ),

  // === CLI TOOLS (pi / pagespace-cli) ===
  // pi tool names are lowercase (read, write, edit, bash, find, grep, ls).
  // These tools return plain strings so `output` carries the content and `parsedOutput` is {}.
  // Renderers must read from `output` directly.

  read: ({ parsedInput, output }) => {
    const path = (parsedInput?.path ?? parsedInput?.file_path) as string | undefined;
    const content = typeof output === 'string' ? output : null;
    if (!content) return null;
    const lines = content.split('\n');
    const preview = lines.slice(0, 20).join('\n') + (lines.length > 20 ? '\n…' : '');
    return <RichContentRenderer title={path ?? 'File'} content={preview} />;
  },

  write: ({ parsedInput, parsedOutput, output }) => {
    if (output == null) return null;
    // pagespace-cli returns a bare "ok" string today, so parsedOutput won't
    // carry oldContent/newContent yet — this upgrades automatically once the
    // CLI reports before/after content instead of just success. Gated on
    // `success` (mirroring insert_content) so a future failed write carrying
    // stale content fields doesn't render as if it succeeded.
    if (parsedOutput.success !== false && typeof parsedOutput.oldContent === 'string' && typeof parsedOutput.newContent === 'string') {
      return (
        <RichDiffRenderer
          title={(parsedInput?.file_path as string | undefined) ?? 'File'}
          oldContent={parsedOutput.oldContent}
          newContent={parsedOutput.newContent}
        />
      );
    }
    return (
      <ActionResultRenderer
        actionType="create"
        success={true}
        title={parsedInput?.file_path as string | undefined}
      />
    );
  },

  edit: ({ parsedInput, parsedOutput, output }) => {
    if (output == null) return null;
    // Same opportunistic upgrade as `write` above, same success gating.
    if (parsedOutput.success !== false && typeof parsedOutput.oldContent === 'string' && typeof parsedOutput.newContent === 'string') {
      return (
        <RichDiffRenderer
          title={(parsedInput?.file_path as string | undefined) ?? 'File'}
          oldContent={parsedOutput.oldContent}
          newContent={parsedOutput.newContent}
        />
      );
    }
    return (
      <ActionResultRenderer
        actionType="update"
        success={true}
        title={parsedInput?.file_path as string | undefined}
      />
    );
  },

  bash: ({ parsedInput, output }) => {
    const command = parsedInput?.command as string | undefined;
    const stdout = typeof output === 'string' ? output : null;
    if (!command && !stdout) return null;
    const lines = stdout?.split('\n') ?? [];
    const preview = lines.slice(0, 10).join('\n') + (lines.length > 10 ? '\n…' : '');
    const content = [command ? `$ ${command}` : null, stdout ? preview : null]
      .filter(Boolean)
      .join('\n');
    return <RichContentRenderer title="Bash" content={content} />;
  },

  find: ({ parsedInput, output }) => {
    const pattern = parsedInput?.pattern as string | undefined;
    const content = typeof output === 'string' ? output : null;
    if (!content) return null;
    return <RichContentRenderer title={pattern ? `Find: ${pattern}` : 'Find'} content={content} />;
  },

  grep: ({ parsedInput, output }) => {
    const pattern = parsedInput?.pattern as string | undefined;
    const content = typeof output === 'string' ? output : null;
    if (!content) return null;
    return <RichContentRenderer title={pattern ? `Grep: ${pattern}` : 'Grep'} content={content} />;
  },

  ls: ({ parsedInput, output }) => {
    const path = parsedInput?.path as string | undefined;
    const content = typeof output === 'string' ? output : null;
    if (!content) return null;
    return <RichContentRenderer title={path ?? 'Directory'} content={content} />;
  },
};

/**
 * Resolve the rich content for a tool call. Applies the error short-circuit and
 * the generic success / raw-JSON fallbacks around the registry lookup, matching
 * the prior inline behaviour of ToolCallRenderer.
 */
export function renderToolContent(ctx: {
  toolName: string;
  parsedInput: Record<string, unknown> | null;
  parsedOutput: Record<string, unknown> | null;
  output: unknown;
  error?: string;
}): React.ReactNode {
  const { toolName, parsedInput, parsedOutput, output, error } = ctx;

  if (error) {
    return (
      <ActionResultRenderer
        actionType="update"
        success={false}
        errorMessage={error}
        title={parsedInput?.title as string}
      />
    );
  }

  // CLI tool renderers receive plain-string output so parsedOutput is always {}.
  // Only bypass the parsedOutput null-guard when a result is actually available
  // (output != null) — otherwise a pending write/edit would show a premature
  // success card before the client has executed the tool. Server tool renderers
  // only run when parsedOutput is present for the same reason.
  const renderer = toolRenderers[toolName];
  if (renderer) {
    const isCliTool = CLI_TOOL_SET.has(toolName);
    if ((isCliTool && output != null) || parsedOutput) {
      const node = renderer({ toolName, parsedInput, parsedOutput: parsedOutput ?? {}, output, error });
      if (node != null) return node;
    }
  }

  if (!parsedOutput) return null;

  // Generic success/failure for any tool exposing a boolean `success`.
  if (typeof parsedOutput.success === 'boolean') {
    return (
      <ActionResultRenderer
        actionType="update"
        success={parsedOutput.success}
        title={(parsedOutput.title || parsedOutput.name) as string | undefined}
        message={parsedOutput.message as string | undefined}
        errorMessage={parsedOutput.error as string | undefined}
      />
    );
  }

  // Raw output fallback for unhandled shapes (preserves debugging visibility).
  if (output != null) {
    const rawContent = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
    return (
      <div className="rounded-lg border bg-card overflow-hidden my-2 shadow-sm">
        <div className="px-3 py-2 bg-muted/30 border-b">
          <span className="text-sm font-medium text-muted-foreground">Result</span>
        </div>
        <pre className="p-3 text-xs overflow-auto max-h-[300px] bg-muted/20">
          <code>{rawContent}</code>
        </pre>
      </div>
    );
  }

  return null;
}
