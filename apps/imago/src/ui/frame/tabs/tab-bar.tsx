'use client';

import { useRouter } from 'next/navigation';
import useSWR from 'swr';
import { pageTypeIcons } from '../../components/page-type-icon/page-type-icon';
import { useImagoPageId } from '../../chat/use-chat-data/use-chat-data';
import { dispatch, transactions } from '../../store/transactions';
import { pageKey } from '../../files/page-object/page-object';
import type { Stage } from '../stage/stage';
import { activeTabOf, stepTab } from './tabs-model';
import { useOpenTabs } from './use-open-tabs';
import { requestNewTab, useNewTabClicks } from './use-new-tab-clicks';
import { pageTabOf, tabLabelFor } from './tab-label';
import { renderTab, renderTabBar } from './tab-bar.render';

type TabItemProps = {
  readonly path: string;
  readonly selected: boolean;
  readonly onOpen: () => void;
  readonly onClose: () => void;
};

/** A page tab's title and type come from the page API, sharing the page view's cache. */
function PageTab({ path, pageId, selected, onOpen, onClose }: TabItemProps & { readonly pageId: string }) {
  const { data } = useSWR<unknown>(pageKey(pageId));
  const page = pageTabOf(data);
  const imago = useImagoPageId() === pageId;
  const look = page === null ? { icon: 'page' as const, hue: null } : pageTypeIcons[page.type];
  return renderTab({ path, title: page?.title ?? 'Loading…', icon: look.icon, hue: look.hue, imago, selected, onOpen, onClose });
}

function TabItem(props: TabItemProps) {
  const label = tabLabelFor(props.path);
  if (label.kind === 'page') return <PageTab {...props} pageId={label.pageId} />;
  if (label.kind === 'conversation') return renderTab({ ...props, title: 'Direct message', icon: 'messages', hue: null });
  return renderTab({ ...props, title: label.title, icon: 'settings', hue: null });
}

export type TabBarProps = {
  readonly stage: Stage;
  /** Whose tabs these are: the drive the spine links into (DEC-C6: per drive). */
  readonly driveKey: string;
};

/**
 * The open-pages tab bar (IMC-1.5). Browser-style, as in classic: a navigation loads into the
 * active tab, and Back and Forward step through that tab's own history (off a tab, on a section
 * or the chat, Back returns to the active tab). New tab, ⌘/Ctrl-click and middle-click open
 * new tabs. Tabs persist per drive under imago's own key.
 */
export function TabBar({ stage, driveKey }: TabBarProps) {
  const router = useRouter();
  const open = useOpenTabs(stage, driveKey);
  useNewTabClicks(stage);

  const active = activeTabOf({ tabs: open.tabs, active: open.activeId });
  const onTab = active !== null && active.path === open.pathname;
  const back = onTab ? stepTab(active, 'back') : active;
  const forward = onTab ? stepTab(active, 'forward') : null;

  return renderTabBar({
    tabs: open.tabs.map((tab) => (
      <TabItem
        key={tab.id}
        path={tab.path}
        selected={open.isCurrent(tab)}
        onOpen={() => open.select(tab.id)}
        onClose={() => open.close(tab.id)}
      />
    )),
    canBack: back !== null,
    canForward: forward !== null,
    onBack: () => {
      if (back === null) return;
      if (onTab) dispatch(transactions.stepBack, undefined);
      router.push(back.path);
    },
    onForward: () => {
      if (forward === null) return;
      dispatch(transactions.stepForward, undefined);
      router.push(forward.path);
    },
    onNew: requestNewTab,
  });
}
