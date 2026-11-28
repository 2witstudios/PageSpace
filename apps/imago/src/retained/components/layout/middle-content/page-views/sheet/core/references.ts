import {
  type SheetData,
  type SheetExternalReferenceToken,
  type SheetExternalReferenceResolution,
} from '@pagespace/lib/sheets/sheet';
import { PageType } from '@pagespace/lib/utils/enums';

/**
 * Pure reference-resolution core for the sheet view: flatten the page tree,
 * build parent lookups, resolve a `[[label]]` token to a concrete sheet page
 * (ranking duplicate titles), and project the async external-sheet cache into
 * the evaluator's resolution shape. No hooks, no fetch — the shell hook owns
 * loading; these functions only compute.
 */

/** The structural slice of a page-tree node this core needs. */
export interface SheetTreeNode {
  id: string;
  parentId?: string | null;
  type: string;
  title: string;
  position?: number | null;
  children?: SheetTreeNode[];
}

/** The async load state of an externally referenced sheet, cached by raw token. */
export type ExternalSheetState =
  | {
      status: 'loading';
      label: string;
      identifier?: string;
      mentionType?: string;
      pageId: string;
      title: string;
    }
  | {
      status: 'ready';
      label: string;
      identifier?: string;
      mentionType?: string;
      pageId: string;
      title: string;
      sheet: SheetData;
    }
  | {
      status: 'error';
      label: string;
      identifier?: string;
      mentionType?: string;
      pageId?: string;
      title?: string;
      error: string;
    };

/** Depth-first flatten of the page tree into a single ordered list. */
export const flattenTree = (nodes: SheetTreeNode[]): SheetTreeNode[] => {
  const items: SheetTreeNode[] = [];
  const walk = (list: SheetTreeNode[]) => {
    for (const nodeItem of list) {
      items.push(nodeItem);
      if (nodeItem.children && nodeItem.children.length > 0) {
        walk(nodeItem.children);
      }
    }
  };
  walk(nodes);
  return items;
};

/** Map each node id to its parent id (or null) for ancestor walks. */
export const buildParentMap = (flattened: SheetTreeNode[]): Map<string, string | null> => {
  const map = new Map<string, string | null>();
  for (const nodeItem of flattened) {
    map.set(nodeItem.id, nodeItem.parentId ?? null);
  }
  return map;
};

/** Walk a node's ancestor chain (inclusive), guarding against parent-map cycles. */
export const buildAncestorChain = (id: string | null | undefined, parentMap: Map<string, string | null>): string[] => {
  const chain: string[] = [];
  const visited = new Set<string>();
  let current: string | null | undefined = id ?? null;
  while (current) {
    if (visited.has(current)) {
      break;
    }
    chain.push(current);
    visited.add(current);
    current = parentMap.get(current) ?? null;
  }
  return chain;
};

/** A duplicate-title candidate with the metrics used to rank it. */
export interface ReferenceMatch {
  node: SheetTreeNode;
  isSibling: boolean;
  sharedDepth: number;
  depth: number;
  position: number;
}

/**
 * Ordering for duplicate-title matches: siblings first, then greater shared
 * ancestry, then shallower depth, then lower position, then title.
 */
export const compareReferenceMatches = (a: ReferenceMatch, b: ReferenceMatch): number => {
  if (a.isSibling !== b.isSibling) {
    return a.isSibling ? -1 : 1;
  }
  if (b.sharedDepth !== a.sharedDepth) {
    return b.sharedDepth - a.sharedDepth;
  }
  if (a.depth !== b.depth) {
    return a.depth - b.depth;
  }
  if (a.position !== b.position) {
    return a.position - b.position;
  }
  return a.node.title.localeCompare(b.node.title);
};

export interface ResolveReferenceContext {
  flattenedPages: SheetTreeNode[];
  parentMap: Map<string, string | null>;
  currentPageId: string;
  currentParentId?: string | null;
}

const isSheet = (nodeItem: SheetTreeNode): boolean => nodeItem.type === PageType.SHEET;

/** Resolve a reference token to a concrete sheet page id + title, or null. */
export const resolveReferenceTarget = (
  reference: SheetExternalReferenceToken,
  ctx: ResolveReferenceContext,
): { pageId: string; title: string } | null => {
  const { flattenedPages, parentMap, currentPageId, currentParentId } = ctx;

  if (reference.identifier) {
    const byId = flattenedPages.find((nodeItem) => nodeItem.id === reference.identifier && isSheet(nodeItem));
    if (byId) {
      return { pageId: byId.id, title: byId.title };
    }
  }

  const normalizedLabel = reference.label.trim().toLowerCase();
  const labelMatches = flattenedPages.filter(
    (nodeItem) => isSheet(nodeItem) && nodeItem.title.trim().toLowerCase() === normalizedLabel,
  );

  if (labelMatches.length === 1) {
    return { pageId: labelMatches[0].id, title: labelMatches[0].title };
  }

  if (labelMatches.length > 1) {
    const currentAncestors = new Set(buildAncestorChain(currentPageId, parentMap));

    const ranked = labelMatches
      .map((nodeItem): ReferenceMatch => {
        const chain = buildAncestorChain(nodeItem.id, parentMap);
        const sharedDepth = chain.reduce(
          (depth, ancestor) => (currentAncestors.has(ancestor) ? depth + 1 : depth),
          0,
        );
        return {
          node: nodeItem,
          isSibling: (nodeItem.parentId ?? null) === (currentParentId ?? null),
          sharedDepth,
          depth: chain.length,
          position: typeof nodeItem.position === 'number' ? nodeItem.position : Number.MAX_SAFE_INTEGER,
        };
      })
      .sort(compareReferenceMatches);

    const best = ranked[0];
    return { pageId: best.node.id, title: best.node.title };
  }

  return null;
};

/** Project the external-sheet cache into the evaluator's resolution for one token. */
export const resolveExternalReference = (
  reference: SheetExternalReferenceToken,
  externalSheets: Record<string, ExternalSheetState>,
): SheetExternalReferenceResolution => {
  const entry = externalSheets[reference.raw];

  if (!entry) {
    return {
      pageId: reference.identifier ?? reference.raw,
      pageTitle: reference.label,
      error: `Referenced page "${reference.label}" is loading`,
    };
  }

  if (entry.status === 'ready') {
    return {
      pageId: entry.pageId,
      pageTitle: entry.title,
      sheet: entry.sheet,
    };
  }

  if (entry.status === 'loading') {
    return {
      pageId: entry.pageId,
      pageTitle: entry.title,
      error: `Referenced page "${entry.title}" is loading`,
    };
  }

  return {
    pageId: entry.pageId ?? reference.identifier ?? reference.raw,
    pageTitle: entry.title ?? reference.label,
    error: entry.error,
  };
};
