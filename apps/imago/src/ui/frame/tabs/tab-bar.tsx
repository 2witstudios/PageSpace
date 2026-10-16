'use client';

import { useRouter } from 'next/navigation';
import useSWR from 'swr';
import { pageTypeIcons } from '../../components/page-type-icon/page-type-icon';
import { useUiState } from '../../store/store';
import { dispatch, transactions } from '../../store/transactions';
import type { UiState } from '../../store/state';
import { pageKey } from '../../files/page-object/page-object';
import type { Stage } from '../stage/stage';
import { goBack, goForward } from './tabs-model';
import { useOpenTabs } from './use-open-tabs';
import { requestNewTab, useNewTabClicks } from './use-new-tab-clicks';
import { pageTabOf, tabLabelFor } from './tab-label';
import { renderTab, renderTabBar } from './tab-bar.render';

const selectHistory = (state: UiState) => state.resources.tabHistory;

type TabItemProps = { readonly path: string; readonly selected: boolean; readonly onClose: () => void };

/** A page tab's title and type come from the page API, sharing the page view's cache. */
function PageTab({ path, pageId, selected, onClose }: TabItemProps & { readonly pageId: string }) {
  const { data } = useSWR<unknown>(pageKey(pageId));
  const page = pageTabOf(data);
  const look = page === null ? { icon: 'page' as const, hue: null } : pageTypeIcons[page.type];
  return renderTab({ path, title: page?.title ?? 'Loading…', icon: look.icon, hue: look.hue, selected, onClose });
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
 * active tab and records the visit; New tab, ⌘/Ctrl-click and middle-click open new tabs.
 * Tabs persist per drive under imago's own key. Closing the active tab
 * moves to its neighbour, and closing the last one closes the middle (its section, where
 * Imago is the ground).
 */
export function TabBar({ stage, driveKey }: TabBarProps) {
  const router = useRouter();
  const { tabs, pathname, close } = useOpenTabs(stage, driveKey);
  const history = useUiState(selectHistory);
  useNewTabClicks(stage);

  const back = history === null ? null : goBack(history);
  const forward = history === null ? null : goForward(history);

  return renderTabBar({
    tabs: tabs.map((tab) => (
      <TabItem key={tab.path} path={tab.path} selected={tab.path === pathname} onClose={() => close(tab.path)} />
    )),
    canBack: back !== null,
    canForward: forward !== null,
    onBack: () => {
      if (back === null) return;
      dispatch(transactions.stepBack, undefined);
      router.push(back.current);
    },
    onForward: () => {
      if (forward === null) return;
      dispatch(transactions.stepForward, undefined);
      router.push(forward.current);
    },
    onNew: requestNewTab,
  });
}
