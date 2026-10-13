'use client';

import useSWR from 'swr';
import { pageTypeIcons } from '../../components/page-type-icon/page-type-icon';
import { pageKey } from '../../files/page-object/page-object';
import { pageTabOf, tabLabelFor } from '../tabs/tab-label';
import type { OpenTabs } from '../tabs/use-open-tabs';
import { renderOpenPageRow, renderOpenPagesSheet } from './phone-open-pages.render';

type RowProps = { readonly path: string; readonly current: boolean; readonly onClose: () => void };

/** A page row's title and type come from the page API, sharing the page view's cache. */
function PageRow({ path, pageId, current, onClose }: RowProps & { readonly pageId: string }) {
  const { data } = useSWR<unknown>(pageKey(pageId));
  const page = pageTabOf(data);
  const look = page === null ? { icon: 'page' as const, hue: null } : pageTypeIcons[page.type];
  return renderOpenPageRow({ path, title: page?.title ?? 'Loading…', icon: look.icon, hue: look.hue, current, onClose });
}

function Row(props: RowProps) {
  const label = tabLabelFor(props.path);
  if (label.kind === 'page') return <PageRow {...props} pageId={label.pageId} />;
  if (label.kind === 'conversation') {
    return renderOpenPageRow({ ...props, title: 'Direct message', icon: 'messages', hue: null });
  }
  return renderOpenPageRow({ ...props, title: label.title, icon: 'settings', hue: null });
}

export type PhoneOpenPagesProps = {
  readonly open: OpenTabs;
  /** Void action: the scrim was pressed. */
  readonly onDismiss: () => void;
};

/** The open-pages sheet bound to the drive's open tabs; closing the last one leaves the empty line. */
export function PhoneOpenPages({ open, onDismiss }: PhoneOpenPagesProps) {
  return renderOpenPagesSheet({
    rows: open.tabs.map((tab) => (
      <Row key={tab.path} path={tab.path} current={tab.path === open.pathname} onClose={() => open.close(tab.path, 'stay')} />
    )),
    onDismiss,
    onCloseAll: open.closeAll,
  });
}
