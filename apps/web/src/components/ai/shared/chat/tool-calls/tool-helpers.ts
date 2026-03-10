import type { TreeItem } from './PageTreeRenderer';

export const safeJsonParse = (value: unknown): Record<string, unknown> | null => {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value === 'object' && value !== null) {
    return value as Record<string, unknown>;
  }
  return null;
};

export const safeJsonParseWithRaw = (value: unknown): Record<string, unknown> | null => {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return { raw: value };
    }
  }
  if (typeof value === 'object' && value !== null) {
    return value as Record<string, unknown>;
  }
  return null;
};

export const buildChannelTranscript = (channelMessages: unknown): string | null => {
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

export const getSendChannelMessagePreview = (
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

export const TOOL_NAME_MAP: Record<string, string> = {
  'ask_agent': 'Ask Agent',
  'list_drives': 'Workspaces',
  'create_drive': 'Create Workspace',
  'rename_drive': 'Rename Workspace',
  'update_drive_context': 'Update Context',
  'list_pages': 'Pages',
  'read_page': 'Read Page',
  'list_trash': 'Trash',
  'list_conversations': 'Conversations',
  'read_conversation': 'Conversation',
  'send_channel_message': 'Send Message',
  'replace_lines': 'Edit Document',
  'create_page': 'Create Page',
  'rename_page': 'Rename Page',
  'trash': 'Move to Trash',
  'restore': 'Restore',
  'move_page': 'Move Page',
  'edit_sheet_cells': 'Edit Sheet',
  'regex_search': 'Search',
  'glob_search': 'Find Pages',
  'multi_drive_search': 'Search All',
  'update_task': 'Update Task',
  'get_assigned_tasks': 'Assigned Tasks',
  'update_agent_config': 'Configure Agent',
  'list_agents': 'Agents',
  'multi_drive_list_agents': 'All Agents',
  'web_search': 'Web Search',
  'get_activity': 'Activity',
};

export const parsePathsToTree = (paths: string[], _driveId?: string): TreeItem[] => {
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
      parsedPages.push({
        type,
        pageId,
        fullPath,
        title,
        pathSegments: segments,
      });
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
        seen.set(mapKey, {
          page: isDirectChild ? page : undefined,
          children: []
        });
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
      const item: TreeItem = {
        path: '/' + currentPath.join('/'),
        title: page?.title || children[0]?.pathSegments[depth] || 'Folder',
        type: page?.type ?? 'FOLDER',
        pageId: page?.pageId,
        children: buildTreeFromParsed(children, depth + 1, currentPath),
      };
      result.push(item);
    }

    return result;
  };

  return buildTreeFromParsed(parsedPages, 1, []);
};

export const countPages = (items: TreeItem[]): number => {
  return items.reduce((count, item) => {
    return count + 1 + (item.children ? countPages(item.children) : 0);
  }, 0);
};
