import Link from 'next/link';
import type { ReactNode } from 'react';
import { Icon } from '../../components/icon/icon';
import type { FileNode } from '../file-model/file-node';
import { fileIcon } from '../tree-view/tree-view';
import {
  treeCheckboxClass,
  treeCaretClass,
  treeRowActionsClass,
  treeChildrenClass,
  treeCountClass,
  treeLinkClass,
  treeNameClass,
  treeRowClass,
  treeSpacerClass,
  treeToggleClass,
} from './tree-row-class';

/** Multi-select on: every row carries a checkbox for its page. */
export type TreeRowSelection = {
  readonly selectedIds: ReadonlySet<string>;
  /** Void action: selects or clears one row's page. */
  readonly toggle: (node: FileNode) => void;
};

export type TreeRowsRenderProps = {
  readonly nodes: readonly FileNode[];
  readonly selectedId: string | null;
  readonly expandedIds: readonly string[];
  /** Rows the server has not listed yet: drawn, not yet linked. */
  readonly pendingIds: readonly string[];
  /** A page's address: /[driveId]/files/[pageId] under imago's basePath. */
  readonly hrefFor: (pageId: string) => string;
  /** Void action: opens or closes a page in the tree. */
  readonly toggle: (pageId: string) => void;
  /** Present while Select multiple is on. */
  readonly selection?: TreeRowSelection;
  /** A row's hover "…": the page actions menu's trigger, when the container supplies one. */
  readonly renderRowActions?: (node: FileNode) => ReactNode;
};

/** A folder always discloses (even empty); another page only when it holds pages. */
const discloses = (node: FileNode): boolean => node.kind === 'folder' || (node.children?.length ?? 0) > 0;

const label = (node: FileNode): ReactNode => (
  <>
    <Icon name={fileIcon(node.pageType)} />
    <span className={treeNameClass}>{node.name}</span>
    {node.count === undefined ? null : <span className={treeCountClass}>{node.count}</span>}
  </>
);

const disclosure = (node: FileNode, expanded: boolean, toggle: (pageId: string) => void): ReactNode =>
  discloses(node) ? (
    <button
      type="button"
      className={treeToggleClass}
      aria-expanded={expanded}
      aria-label={`${expanded ? 'Collapse' : 'Expand'} ${node.name}`}
      onClick={() => toggle(node.id)}
    >
      <span className={treeCaretClass(expanded)} aria-hidden="true">
        <Icon name="chevronRight" size={12} />
      </span>
    </button>
  ) : (
    <span className={treeSpacerClass} aria-hidden="true" />
  );

/**
 * The tree's rows: each a 32px row whose caret discloses the pages under it
 * and whose name opens the page (prefetched). Nesting is a real `<ul>` per
 * level, so the depth is in the markup and assistive technology follows it.
 */
export function renderTreeRows(props: TreeRowsRenderProps): ReactNode {
  const { nodes, selectedId, expandedIds, pendingIds, hrefFor, toggle, selection, renderRowActions } = props;
  return nodes.map((node) => {
    const expanded = discloses(node) && expandedIds.includes(node.id);
    const selected = node.id === selectedId;
    const pending = pendingIds.includes(node.id);
    const children = node.children ?? [];
    return (
      <li key={node.id}>
        <div className={`${treeRowClass({ selected, pending })} group`} data-page-type={node.pageType}>
          {disclosure(node, expanded, toggle)}
          {selection === undefined ? null : (
            <input
              type="checkbox"
              className={treeCheckboxClass}
              aria-label={`Select ${node.name}`}
              checked={selection.selectedIds.has(node.id)}
              onChange={() => selection.toggle(node)}
            />
          )}
          {pending ? (
            <span className={treeLinkClass} aria-busy="true" aria-current={selected ? 'page' : undefined}>
              {label(node)}
            </span>
          ) : (
            <Link
              href={hrefFor(node.id)}
              prefetch
              className={treeLinkClass}
              aria-current={selected ? 'page' : undefined}
            >
              {label(node)}
            </Link>
          )}
          {renderRowActions === undefined ? null : <span className={treeRowActionsClass}>{renderRowActions(node)}</span>}
        </div>
        {expanded && children.length > 0 ? (
          <ul className={treeChildrenClass} aria-label={node.name}>
            {renderTreeRows({ ...props, nodes: children })}
          </ul>
        ) : null}
      </li>
    );
  });
}
