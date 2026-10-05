// What the files tree pane draws, from the drive's tree as file nodes: only
// the pages the drive tree listed, the creates still in flight, and the
// filter's matches with the path down to them.

import type { PageTypeValue } from '@pagespace/lib/client-safe';
import type { IconName } from '../../components/icon/icon-names';
import type { FileNode, PageTreeResponse } from '../file-model/file-node';
import type { PendingFile } from '../files-plugin/files-plugin';

/** Each page type's glyph, as classic draws it (page-types.config iconName). */
const icons: Readonly<Record<PageTypeValue, IconName>> = {
  FOLDER: 'folder',
  DOCUMENT: 'page',
  CHANNEL: 'messages',
  AI_CHAT: 'bot',
  CANVAS: 'canvas',
  FILE: 'file',
  SHEET: 'sheet',
  TASK_LIST: 'tasks',
  CODE: 'code',
};

export const fileIcon = (pageType: PageTypeValue): IconName => icons[pageType];

/** Every page id the drive tree answer nests, at any depth. */
export const listedIdsFrom = (pages: readonly PageTreeResponse[]): ReadonlySet<string> => {
  const ids = new Set<string>();
  const walk = (level: readonly PageTreeResponse[]) => {
    for (const page of level) {
      ids.add(page.id);
      walk(page.children ?? []);
    }
  };
  walk(pages);
  return ids;
};

/**
 * The nodes the drive tree listed. A children load can name a page the drive
 * tree did not (apps/web's children route checks only the parent), and the
 * pane never draws one: the drive tree alone decides what the viewer sees.
 * The same nodes come back when nothing is left out.
 */
export const onlyListed = (nodes: readonly FileNode[], listed: ReadonlySet<string>): readonly FileNode[] => {
  let changed = false;
  const kept = nodes.flatMap((node): FileNode[] => {
    if (!listed.has(node.id)) {
      changed = true;
      return [];
    }
    if (node.children === undefined) return [node];
    const children = onlyListed(node.children, listed);
    if (children === node.children) return [node];
    changed = true;
    return [node.count === undefined ? { ...node, children } : { ...node, children, count: children.length }];
  });
  return changed ? kept : nodes;
};

/**
 * The rows a filter keeps: every page whose name holds it (any case), with
 * everything under it, and the pages above each match so its path shows. A
 * blank filter keeps the tree as it is.
 */
export const filterTree = (nodes: readonly FileNode[], filter: string): readonly FileNode[] => {
  const needle = filter.trim().toLowerCase();
  if (needle === '') return nodes;
  const keep = (level: readonly FileNode[]): readonly FileNode[] =>
    level.flatMap((node): FileNode[] => {
      if (node.name.toLowerCase().includes(needle)) return [node];
      const kept = keep(node.children ?? []);
      return kept.length === 0 ? [] : [{ ...node, children: kept }];
    });
  return keep(nodes);
};

/** Every page that holds pages: a filtered tree opens them all so its matches show. */
export const disclosableIds = (nodes: readonly FileNode[]): readonly string[] =>
  nodes.flatMap((node) =>
    node.children === undefined || node.children.length === 0 ? [] : [node.id, ...disclosableIds(node.children)],
  );

/** The node with this id and every node above it, top first; undefined when absent. */
const pathTo = (nodes: readonly FileNode[], id: string): readonly FileNode[] | undefined => {
  for (const node of nodes) {
    if (node.id === id) return [node];
    const below = pathTo(node.children ?? [], id);
    if (below !== undefined) return [node, ...below];
  }
  return undefined;
};

/**
 * Where + creates a page: in the selected folder; beside a selected page
 * (in the page that holds it, as classic's quick create does); at the top of
 * the drive when nothing the tree holds is selected.
 */
export const createParentFor = (nodes: readonly FileNode[], selectedId: string | null): string | null => {
  const path = selectedId === null ? undefined : pathTo(nodes, selectedId);
  if (path === undefined) return null;
  const selected = path[path.length - 1];
  if (selected.kind === 'folder') return selected.id;
  return path.length > 1 ? path[path.length - 2].id : null;
};

const childrenOf = (nodes: readonly FileNode[], parentId: string | null): readonly FileNode[] | undefined => {
  if (parentId === null) return nodes;
  const path = pathTo(nodes, parentId);
  return path === undefined ? undefined : (path[path.length - 1].children ?? []);
};

/** The ids under a page (or the top of the drive); none for a page the tree does not hold. */
export const childIdsOf = (nodes: readonly FileNode[], parentId: string | null): readonly string[] =>
  (childrenOf(nodes, parentId) ?? []).map((node) => node.id);

/** `node` appended under `parentId` (null: the top); undefined when the tree has no such parent. */
const appendUnder = (
  nodes: readonly FileNode[],
  parentId: string | null,
  node: FileNode,
): readonly FileNode[] | undefined => {
  if (parentId === null) return [...nodes, node];
  let found = false;
  const walk = (level: readonly FileNode[]): readonly FileNode[] =>
    level.map((entry) => {
      if (found) return entry;
      if (entry.id === parentId) {
        found = true;
        const children = [...(entry.children ?? []), node];
        return entry.count === undefined ? { ...entry, children } : { ...entry, children, count: children.length };
      }
      if (entry.children === undefined) return entry;
      const below = walk(entry.children);
      return found ? { ...entry, children: below } : entry;
    });
  const next = walk(nodes);
  return found ? next : undefined;
};

export type PendingTree = {
  readonly nodes: readonly FileNode[];
  /** The rows still waiting for the server: drawn, but not yet a page to open. */
  readonly pendingIds: readonly string[];
};

/**
 * The tree with this drive's creates in flight drawn where they were asked
 * for, each once. A create the tree already lists draws nothing of its own:
 * by its server id once it answered, and before that by a page the tree
 * gained under its parent since it began (a new page with its title and type
 * that no other create claims), so a socket revalidation landing before the
 * create's answer never shows the page twice.
 */
export const withPendingCreates = (
  nodes: readonly FileNode[],
  pending: readonly PendingFile[],
  driveId: string,
): PendingTree => {
  const claimed = new Set(pending.flatMap((file) => (file.pageId === null ? [] : [file.pageId])));
  const listed = new Set<string>();
  const walk = (level: readonly FileNode[]) => {
    for (const node of level) {
      listed.add(node.id);
      walk(node.children ?? []);
    }
  };
  walk(nodes);

  let shown = nodes;
  const pendingIds: string[] = [];
  for (const file of pending) {
    if (file.driveId !== driveId) continue;
    if (file.pageId !== null && listed.has(file.pageId)) continue;
    if (file.pageId === null) {
      const known = new Set(file.knownIds);
      const arrival = (childrenOf(nodes, file.parentId) ?? []).find(
        (node) =>
          node.pageType === 'DOCUMENT' && node.name === file.title && !known.has(node.id) && !claimed.has(node.id),
      );
      if (arrival !== undefined) {
        claimed.add(arrival.id);
        continue;
      }
    }
    const id = file.pageId ?? file.key;
    const next = appendUnder(shown, file.parentId, { id, name: file.title, kind: 'page', pageType: 'DOCUMENT' });
    if (next === undefined) continue;
    shown = next;
    pendingIds.push(id);
  }
  return { nodes: shown, pendingIds };
};

/** This drive's answered creates the drive tree now lists: their rows can go. */
export const settledKeys = (
  pending: readonly PendingFile[],
  listed: ReadonlySet<string>,
  driveId: string,
): readonly string[] =>
  pending
    .filter((file) => file.driveId === driveId && file.pageId !== null && listed.has(file.pageId))
    .map((file) => file.key);
