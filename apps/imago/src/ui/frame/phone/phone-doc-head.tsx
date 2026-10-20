'use client';

import { useState, type ReactNode } from 'react';
import { renderIcon } from '../../components/icon/icon.render';
import { usePage } from '../../files/page-object/page-object';
import { PageActionsMenu } from '../../files/page-actions/page-actions';
import type { PageActionDialog } from '../../files/page-actions/page-actions-model';
import { PageHeadDialogs, openAddChild } from '../../files/page-head/page-head-dialogs';
import { driveIdOf, isCollaborative } from '../../files/page-head/page-head-model';
import { usePageTrail } from '../../tasks/use-tasks/use-tasks';
import { RetainedSurface } from '@/retained-adapters/retained-provider';
import { PageViewers } from '@/retained/components/common/PageViewers';
import { usePagePresence } from '@/retained/hooks/usePagePresence';
import type { Stage } from '../stage/stage';
import { pageTabOf } from '../tabs/tab-label';
import { useOpenTabs } from '../tabs/use-open-tabs';
import { phoneHeadControlClass } from './phone-files-header-class';
import { renderPhoneDocHead } from './phone-doc-head.render';
import { PhoneOpenPages } from './phone-open-pages';

export type PhoneDocHeadProps = {
  readonly stage: Stage;
  readonly pageId: string;
};

/**
 * The phone page head bound to the page API, the page trail, presence and the drive's open
 * tabs. The open-pages sheet opens from its count button.
 */
export function PhoneDocHead({ stage, pageId }: PhoneDocHeadProps): ReactNode {
  const { data } = usePage(pageId);
  const page = pageTabOf(data);
  const driveId = driveIdOf(data);
  const { trail } = usePageTrail(pageId);
  usePagePresence(pageId);
  const open = useOpenTabs(stage);
  const [sheet, setSheet] = useState(false);
  const [dialog, setDialog] = useState<PageActionDialog | null>(null);
  const settled = trail?.at(-1)?.id === pageId;
  const parent = settled ? (trail?.at(-2)?.title ?? null) : null;
  const openDialog = (next: PageActionDialog) => {
    if (next === 'add-child') openAddChild(pageId);
    else setDialog(next);
  };
  const filesHref = stage.driveId === null ? '/' : `/${encodeURIComponent(stage.driveId)}/files`;
  return (
    <>
      {renderPhoneDocHead({
        backHref: filesHref,
        parent,
        title: page?.title ?? (settled ? (trail?.at(-1)?.title ?? '') : ''),
        presence:
          page !== null && isCollaborative(page.type) ? (
            <RetainedSurface fill={false}>
              <PageViewers pageId={pageId} size="sm" />
            </RetainedSurface>
          ) : null,
        count: open.tabs.length,
        onOpenPages: () => setSheet(true),
        actions:
          page === null || driveId === null ? null : (
            <PageActionsMenu
              driveId={driveId}
              pageId={pageId}
              onDialog={openDialog}
              trigger={
                <button type="button" className={phoneHeadControlClass} aria-label="Page actions">
                  {renderIcon({ name: 'more', size: 18 })}
                </button>
              }
            />
          ),
      })}
      {driveId === null ? null : <PageHeadDialogs pageId={pageId} driveId={driveId} dialog={dialog} onClose={() => setDialog(null)} />}
      {sheet ? <PhoneOpenPages open={open} onDismiss={() => setSheet(false)} /> : null}
    </>
  );
}
