'use client';

import type { ReactNode } from 'react';
import { usePage } from '../page-object/page-object';
import { usePageTrail } from '../../tasks/use-tasks/use-tasks';
import { renderIcon } from '../../components/icon/icon.render';
import { headControlClass } from '../../frame/controls/controls-class';
import { useDisclosure } from '../../frame/disclosure/use-disclosure';
import { pageTabOf } from '../../frame/tabs/tab-label';
import { RetainedSurface } from '@/retained-adapters/retained-provider';
import { PageHistory } from '@/retained-adapters/page-history';
import { ShareDialog } from '@/retained/components/layout/middle-content/content-header/page-settings/ShareDialog';
import { PageViewers } from '@/retained/components/common/PageViewers';
import { usePagePresence } from '@/retained/hooks/usePagePresence';
import { ExportDropdown } from '@/retained/components/layout/middle-content/content-header/ExportDropdown';
import { PageSetupButton } from '@/retained/components/layout/middle-content/content-header/PageSetupButton';
import PublishControls from '@/retained/components/layout/middle-content/content-header/PublishControls';
import { isPublishablePageType } from '@pagespace/lib/content/page-types.config';
import { PageType, type PageTypeValue } from '@pagespace/lib/utils/enums';
import { crumbsOf, isCollaborative } from './page-head-model';
import { crumbClass, crumbSeparatorClass, crumbsClass, pageActionsMenuClass, pageHeadClass } from './page-head-class';

export type PageHeadProps = {
  readonly pageId: string;
  /** Show sidebar, while the pane is closed. */
  readonly leading: ReactNode;
  /** The Ask pill (Imago collapsed) and Close page. */
  readonly trailing: ReactNode;
};

/**
 * "…" Page actions: the page actions classic's header carried (Page setup, Export, Publish,
 * History), gathered here because v3 has no second header bar. Which of these the "…" menu
 * keeps is the open decision "Page … menu" (tk8o9kzohmat9ueheb5g9vss): this ships them as
 * they are, adds none, and is flagged rather than resolved.
 */
function PageActions({ pageId, type, title }: { readonly pageId: string; readonly type: PageTypeValue; readonly title: string }) {
  const { open, setOpen, ref } = useDisclosure();
  const pageType = PageType[type];
  return (
    <details ref={ref} className="relative" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className={`${headControlClass} summary-plain`} aria-label="Page actions" title="Page actions">
        {renderIcon({ name: 'more', size: 15 })}
      </summary>
      <div className={pageActionsMenuClass} role="group" aria-label="Page actions">
        <RetainedSurface fill={false}>
          <div className="flex flex-col items-stretch gap-1">
            {type === 'DOCUMENT' ? <PageSetupButton pageId={pageId} /> : null}
            {type === 'DOCUMENT' || type === 'SHEET' ? <ExportDropdown pageId={pageId} pageTitle={title} pageType={pageType} /> : null}
            {isPublishablePageType(pageType) && type !== 'CANVAS' ? <PublishControls pageId={pageId} contentDirty={false} /> : null}
            <PageHistory />
          </div>
        </RetainedSurface>
      </div>
    </details>
  );
}

/**
 * The page head (SPEC v3.3): [Show sidebar] · the path · presence (collaborative pages) ·
 * Share · "…" · [Ask] · divider · Close page. It is the page's only header: the body keeps a
 * big title only where the board does (documents).
 */
export function PageHead({ pageId, leading, trailing }: PageHeadProps) {
  const { data } = usePage(pageId);
  const page = pageTabOf(data);
  const { trail } = usePageTrail(pageId);
  // Joining the page's presence room was classic's header's job; the head keeps it.
  usePagePresence(pageId);
  const crumbs = crumbsOf(trail, pageId, page?.type ?? null);
  return (
    <header className={pageHeadClass}>
      {leading}
      <ol aria-label="Path" className={crumbsClass}>
        {crumbs.map((crumb, index) => (
          <li key={crumb.id} className="flex min-w-0 items-center gap-1">
            {index === 0 ? null : (
              <span aria-hidden="true" className={crumbSeparatorClass}>
                ›
              </span>
            )}
            <span className={crumbClass(crumb.current)} aria-current={crumb.current ? 'page' : undefined}>
              {crumb.label}
            </span>
          </li>
        ))}
      </ol>
      <span className="flex flex-none items-center gap-1 pl-2">
        {page !== null && isCollaborative(page.type) ? (
          <RetainedSurface fill={false}>
            <PageViewers pageId={pageId} size="sm" />
          </RetainedSurface>
        ) : null}
        <span className="share-trigger">
          <RetainedSurface fill={false}>
            <ShareDialog pageId={pageId} />
          </RetainedSurface>
        </span>
        {page === null ? null : <PageActions pageId={pageId} type={page.type} title={page.title} />}
        {trailing}
      </span>
    </header>
  );
}
