import Link from 'next/link';
import type { ReactNode } from 'react';
import { Icon } from '../../components/icon/icon';
import { renderPaneHeader } from '../../frame/pane/pane-header';
import {
  documentColumnClass,
  documentCrumbClass,
  documentCrumbCurrentClass,
  documentCrumbLinkClass,
  documentCrumbsClass,
  documentScrollClass,
  documentTitleClass,
  documentViewClass,
} from './document-view-class';

/** A page above the document in its drive's tree. */
export type DocumentCrumb = { readonly id: string; readonly title: string };

export type DocumentViewRenderProps = {
  readonly title: string;
  /** The pages above the document, top of the drive first. */
  readonly crumbs: readonly DocumentCrumb[];
  readonly hrefFor: (pageId: string) => string;
  /** The title in the reading column; the plain title when not given. */
  readonly heading?: ReactNode;
  /** How saving stands, under the title. */
  readonly notice?: ReactNode;
  /** The document's content. */
  readonly body: ReactNode;
};

const separator = <Icon name="chevronRight" size={12} />;

/** Where the document sits: each page above it a link, then the document itself. */
const crumbsOf = ({ title, crumbs, hrefFor }: DocumentViewRenderProps): ReactNode => (
  <nav aria-label="Page path" className={documentCrumbsClass}>
    {crumbs.map((crumb) => (
      <span key={crumb.id} className={documentCrumbClass}>
        <Link href={hrefFor(crumb.id)} prefetch className={documentCrumbLinkClass}>
          {crumb.title}
        </Link>
        {separator}
      </span>
    ))}
    <span aria-current="page" className={documentCrumbCurrentClass}>
      {title}
    </span>
  </nav>
);

/** A document opened as the object: its path in the header, then its title and content in the reading column. */
export function renderDocumentView(props: DocumentViewRenderProps): ReactNode {
  const { title, heading = title, notice = null, body } = props;
  return (
    <article className={documentViewClass} aria-label={title} data-document="">
      {renderPaneHeader({ title: crumbsOf(props) })}
      <div className={documentScrollClass}>
        <div className={documentColumnClass} data-reading-column="">
          <h1 className={documentTitleClass}>{heading}</h1>
          {notice}
          {body}
        </div>
      </div>
    </article>
  );
}
