import { format } from 'date-fns';
import type { SnapshotPageNode } from '@/services/api/snapshot-pages-service';

export function formatSnapshotLabel(backup: {
  label: string | null;
  createdAt: string;
  source: string;
}): string {
  if (backup.label) return backup.label;
  return `${backup.source} snapshot — ${format(new Date(backup.createdAt), 'MMM d, yyyy h:mm a')}`;
}

export function flattenTree(
  nodes: SnapshotPageNode[],
  depth = 0,
): Array<SnapshotPageNode & { depth: number }> {
  const result: Array<SnapshotPageNode & { depth: number }> = [];
  for (const node of nodes) {
    result.push({ ...node, depth });
    if (node.children.length > 0) {
      result.push(...flattenTree(node.children, depth + 1));
    }
  }
  return result;
}

const ICON_MAP: Record<string, string> = {
  DOCUMENT: 'FileText',
  CODE: 'FileCode',
  SHEET: 'FileSpreadsheet',
  CANVAS: 'FileImage',
  FILE: 'File',
  FOLDER: 'Folder',
  CHANNEL: 'MessagesSquare',
  AI_CHAT: 'BotMessageSquare',
  TASK_LIST: 'SquareCheckBig',
};

export function getNodeIcon(type: string): string {
  return ICON_MAP[type] ?? 'File';
}
