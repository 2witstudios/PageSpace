/**
 * Shared utilities for ToolCallRenderer and CompactToolCallRenderer.
 * Extracted to eliminate ~200 lines of duplication between the two renderers.
 */

import type { TreeItem } from './PageTreeRenderer';
import type { ActivityItem } from './ActivityRenderer';

// ── Shared Types ──

export interface ToolPart {
  type: string;
  toolName?: string;
  toolCallId?: string;
  state?: 'input-streaming' | 'input-available' | 'output-available' | 'output-error' | 'done' | 'streaming';
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

// ── JSON Parsing ──

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

/** Like safeJsonParse, but wraps unparseable strings as { raw: value } instead of returning null */
export const safeJsonParseRaw = (value: unknown): Record<string, unknown> | null => {
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

// ── Tool Name Mapping ──

export const TOOL_NAME_MAP: Record<string, string> = {
  // Drive tools
  'list_drives': 'Workspaces',
  'create_drive': 'Create Workspace',
  'rename_drive': 'Rename Workspace',
  'update_drive_context': 'Update Context',
  // Page read tools
  'list_pages': 'Pages',
  'read_page': 'Read Page',
  'list_trash': 'Trash',
  'list_conversations': 'Conversations',
  'read_conversation': 'Conversation',
  // Page write tools
  'replace_lines': 'Edit Document',
  'create_page': 'Create Page',
  'rename_page': 'Rename Page',
  'trash': 'Move to Trash',
  'restore': 'Restore',
  'move_page': 'Move Page',
  'edit_sheet_cells': 'Edit Sheet',
  // Search tools
  'regex_search': 'Search',
  'glob_search': 'Find Pages',
  'multi_drive_search': 'Search All',
  // Task tools
  'update_task': 'Update Task',
  'get_assigned_tasks': 'Assigned Tasks',
  // Agent tools
  'update_agent_config': 'Configure Agent',
  'list_agents': 'Agents',
  'multi_drive_list_agents': 'All Agents',
  'ask_agent': 'Ask Agent',
  // Web search
  'web_search': 'Web Search',
  // Activity
  'get_activity': 'Activity',
};

export function formatToolName(toolName: string): string {
  return TOOL_NAME_MAP[toolName] || toolName.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// ── Tree Utilities ──

export const countPages = (items: TreeItem[]): number => {
  return items.reduce((count, item) => {
    return count + 1 + (item.children ? countPages(item.children) : 0);
  }, 0);
};

// ── Activity Utilities ──

export type ActivityAction = 'created' | 'updated' | 'deleted' | 'restored' | 'moved' | 'commented' | 'renamed';

export const opToAction = (op: string): ActivityAction => {
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

interface DriveGroup {
  drive: { id: string; name: string; slug: string; context?: string | null };
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
  stats?: { total: number; byOp: Record<string, number>; aiCount: number };
}

interface Actor {
  email: string;
  name: string | null;
  isYou: boolean;
  count: number;
}

export function flattenActivityGroups(driveGroups: DriveGroup[], actors: Actor[]): ActivityItem[] {
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
  return flatActivities;
}
