import Link from 'next/link';
import type { ReactNode } from 'react';
import { renderButton } from '../../components/button/button.render';
import { Icon } from '../../components/icon/icon';
import { renderEmptyState } from '../../frame/edge-state/edge-state.render';
import { modifiedLabel } from '../../time/time';
import type { FileNode } from '../file-model/file-node';
import { filesNoteClass } from '../files-pane/files-pane-class';
import { fileIcon, fileKind } from '../tree-view/tree-view';
import {
  folderCellClass,
  folderCrumbClass,
  folderCrumbCurrentClass,
  folderCrumbItemClass,
  folderCrumbSeparatorClass,
  folderHeadClass,
  folderLinkClass,
  folderMetaClass,
  folderNameClass,
  folderPathClass,
  folderRowClass,
  folderTableClass,
  folderViewClass,
} from './folder-view-class';

export type FolderViewRenderProps = {
  /** The pages from the top of the drive down to the open folder, which comes last. */
  readonly path: readonly FileNode[];
  /** The files section's address: the path's first crumb. */
  readonly filesHref: string;
  /** A page's address: /[driveId]/files/[pageId] under imago's basePath. */
  readonly hrefFor: (pageId: string) => string;
  /** Rows the server has not listed yet: drawn, not yet linked. */
  readonly pendingIds: readonly string[];
  /** The viewer's day (YYYY-MM-DD) that Modified reads against. */
  readonly today: string;
  /** Void action: creates a document in this folder and opens it. */
  readonly create: () => void;
  /** A create in this drive is waiting for the server. */
  readonly creating: boolean;
  /** Why the last create failed, if it did. */
  readonly createError: string | null;
};

const crumbs = (
  folder: FileNode,
  ancestors: readonly FileNode[],
  filesHref: string,
  hrefFor: (pageId: string) => string,
): ReactNode => {
  const separator = (
    <span className={folderCrumbSeparatorClass} aria-hidden="true">
      ›
    </span>
  );
  return (
    <nav aria-label="Folder path">
      <ol className={folderPathClass}>
        <li className={folderCrumbItemClass}>
          <Link href={filesHref} prefetch className={folderCrumbClass}>
            Files
          </Link>
        </li>
        {ancestors.map((ancestor) => (
          <li key={ancestor.id} className={folderCrumbItemClass}>
            {separator}
            <Link href={hrefFor(ancestor.id)} prefetch className={folderCrumbClass}>
              {ancestor.name}
            </Link>
          </li>
        ))}
        <li className={folderCrumbItemClass}>
          {separator}
          <span className={folderCrumbCurrentClass} aria-current="location">
            {folder.name}
          </span>
        </li>
      </ol>
    </nav>
  );
};

const name = (node: FileNode): ReactNode => (
  <>
    <Icon name={fileIcon(node.pageType)} />
    <span className={folderNameClass} data-name="">
      {node.name}
    </span>
  </>
);

/** A create still in flight has no time yet: only pages the server listed carry one. */
const modified = (node: FileNode, today: string): ReactNode => {
  if (node.updatedAt === undefined) return 'Creating…';
  return <time dateTime={node.updatedAt}>{modifiedLabel(node.updatedAt, today)}</time>;
};

const row = (node: FileNode, props: FolderViewRenderProps): ReactNode => {
  const pending = props.pendingIds.includes(node.id);
  return (
    <tr
      key={node.id}
      className={folderRowClass(pending)}
      data-page-type={node.pageType}
      aria-busy={pending ? 'true' : undefined}
    >
      <td className={folderCellClass}>
        {pending ? (
          <span className={folderLinkClass}>{name(node)}</span>
        ) : (
          <Link href={props.hrefFor(node.id)} prefetch className={folderLinkClass}>
            {name(node)}
          </Link>
        )}
      </td>
      <td className={folderMetaClass} data-kind="">
        {fileKind(node.pageType)}
      </td>
      <td className={folderMetaClass} data-modified="">
        {modified(node, props.today)}
      </td>
    </tr>
  );
};

/**
 * A folder opened as the object: the Finder half of the files stage, with
 * the tree on its left and the chat on its right. The path leads back up the
 * drive; each row is a link, so a page opens as its object, a folder opens
 * in place, and the back button walks back up. An empty folder offers New
 * page, which creates a document in it.
 */
export function renderFolderView(props: FolderViewRenderProps): ReactNode {
  const { path, filesHref, hrefFor, create, creating, createError } = props;
  const folder = path.at(-1);
  if (folder === undefined) return null;
  const children = folder.children ?? [];
  return (
    <section className={folderViewClass} aria-label={folder.name}>
      {crumbs(folder, path.slice(0, -1), filesHref, hrefFor)}
      {createError === null ? null : (
        <p role="alert" className={filesNoteClass}>
          {createError}
        </p>
      )}
      {children.length === 0 ? (
        renderEmptyState({
          title: 'This folder is empty',
          detail: 'Pages you add here show up in it.',
          action: renderButton({ variant: 'secondary', onClick: create, disabled: creating, children: 'New page' }),
        })
      ) : (
        <table className={folderTableClass} aria-label={`${folder.name} contents`}>
          <thead>
            <tr>
              <th scope="col" className={folderHeadClass}>
                Name
              </th>
              <th scope="col" className={folderHeadClass}>
                Kind
              </th>
              <th scope="col" className={folderHeadClass}>
                Modified
              </th>
            </tr>
          </thead>
          <tbody>{children.map((child) => row(child, props))}</tbody>
        </table>
      )}
    </section>
  );
}
