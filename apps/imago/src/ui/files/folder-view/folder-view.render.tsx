import Link from 'next/link';
import type { ReactNode } from 'react';
import { renderButton } from '../../components/button/button.render';
import { pageTypeIcons } from '../../components/page-type-icon/page-type-icon';
import { renderEmptyState } from '../../frame/edge-state/edge-state.render';
import { ToolbarStrip } from '../../frame/toolbar-strip/toolbar-strip';
import { modifiedLabel } from '../../time/time';
import type { FileNode } from '../file-model/file-node';
import { filesNoteClass } from '../files-pane/files-pane-class';
import { fileKind } from '../tree-view/tree-view';
import type { PageTypeValue } from '@pagespace/lib/client-safe';
import {
  folderBodyClass,
  folderBrowseClass,
  folderCellClass,
  folderContentClass,
  folderCountClass,
  folderCreatingClass,
  folderDotClass,
  folderHeadClass,
  folderHeadEndClass,
  folderKindClass,
  folderLinkClass,
  folderNameClass,
  folderRowClass,
  folderTableClass,
  folderViewClass,
  folderWhenClass,
} from './folder-view-class';

export type FolderViewRenderProps = {
  /** The pages from the top of the drive down to the open folder, which comes last. */
  readonly path: readonly FileNode[];
  /** The files section's address: the Browse files link. */
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

/** "<name> · <n> pages" for the strip; one page reads singular. */
/** The board's Kind column names two types its own way; the rest are classic's displayName. */
const boardKinds: Partial<Record<PageTypeValue, string>> = { AI_CHAT: 'AI agent', TASK_LIST: 'Task list' };

const folderKind = (pageType: PageTypeValue): string => boardKinds[pageType] ?? fileKind(pageType);

const countLabel = (folder: FileNode, count: number): string =>
  `${folder.name} · ${count} ${count === 1 ? 'page' : 'pages'}`;

/** The name cell: the page's type dot, then its title, with Creating… while it is being made. */
const name = (node: FileNode, pending: boolean): ReactNode => (
  <>
    <span aria-hidden="true" data-dot="" className={`${folderDotClass} ${pageTypeIcons[node.pageType].hue}`} />
    <span className={folderNameClass} data-name="">
      {node.name}
    </span>
    {pending ? <span className={folderCreatingClass}>Creating…</span> : null}
  </>
);

/** A create still in flight has no time yet: only pages the server listed carry one. */
const modified = (node: FileNode, today: string): ReactNode => {
  if (node.updatedAt === undefined) return '—';
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
          <span className={folderLinkClass}>{name(node, pending)}</span>
        ) : (
          <Link href={props.hrefFor(node.id)} prefetch className={folderLinkClass}>
            {name(node, pending)}
          </Link>
        )}
      </td>
      <td className={folderKindClass} data-kind="">
        {folderKind(node.pageType)}
      </td>
      <td className={folderWhenClass} data-modified="">
        {modified(node, props.today)}
      </td>
    </tr>
  );
};

/**
 * A folder opened as the object (C-Files-Folder): a Folder tools strip with
 * its name and page count, a Browse files link and New document, then the
 * table of its pages. Each row is a link, so a page opens as its object and
 * a folder opens in place. The path to the folder lives in the page head.
 */
export function renderFolderView(props: FolderViewRenderProps): ReactNode {
  const { path, filesHref, create, creating, createError } = props;
  const folder = path.at(-1);
  if (folder === undefined) return null;
  const children = folder.children ?? [];
  return (
    <section className={folderViewClass} aria-label={folder.name}>
      <ToolbarStrip label="Folder tools">
        <span className={folderCountClass}>{countLabel(folder, children.length)}</span>
        <Link href={filesHref} prefetch title="Browse files (grid / list)" className={folderBrowseClass}>
          Browse files
        </Link>
        <div className="flex-1" />
        {renderButton({ variant: 'primary', onClick: create, disabled: creating, children: 'New document' })}
      </ToolbarStrip>
      <div className={folderBodyClass}>
        <div className={folderContentClass}>
          {createError === null ? null : (
            <p role="alert" className={filesNoteClass}>
              {createError}
            </p>
          )}
          {children.length === 0 ? (
            renderEmptyState({
              title: 'This folder is empty',
              detail: 'Pages you add here show up in it.',
            })
          ) : (
            <table className={folderTableClass} aria-label={`${folder.name} contents`}>
              <thead>
                <tr>
                  <th scope="col" className={folderHeadClass}>
                    Name
                  </th>
                  <th scope="col" className={folderHeadClass}>
                    Type
                  </th>
                  <th scope="col" className={folderHeadEndClass}>
                    Modified
                  </th>
                </tr>
              </thead>
              <tbody>{children.map((child) => row(child, props))}</tbody>
            </table>
          )}
        </div>
      </div>
    </section>
  );
}
