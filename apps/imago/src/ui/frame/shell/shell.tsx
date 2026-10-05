'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { SignOutButton } from '@/components/SignOutButton';
import { useUiState } from '../../store/store';
import type { UiState } from '../../store/state';
import { MessagesPane } from '../../messages/messages-pane/messages-pane';
import { renderPaneHeader } from '../pane/pane-header';
import { ListOpener, ListPane } from '../list-pane/list-pane';
import {
  chatContextFor,
  isListSection,
  paneLayout,
  stageFor,
  type PaneLayout,
  type Section,
  type Stage,
} from '../stage/stage';
import { columnClass } from './shell-class';
import { renderShell } from './shell.render';

export type ShellProps = {
  /** The route's page: it renders only the object's content. */
  readonly children: ReactNode;
};

const titles: Readonly<Record<Section, string>> = {
  chat: 'Chat',
  files: 'Files',
  messages: 'Messages',
  tasks: 'Tasks',
  settings: 'Settings',
  account: 'Account',
};

const selectCollapsed = (state: UiState) => state.resources.collapsedSections;

/** × on the stage-2 list steps back to the drive chat, or the Home root. */
const chatHref = (stage: Stage): string =>
  stage.driveId === null ? '/' : `/${encodeURIComponent(stage.driveId)}`;

/** A section's rows: channels and DMs in Messages; the other sections' arrive with their leaves. */
const rowsFor = (stage: Stage): ReactNode =>
  stage.section === 'messages' ? (
    <MessagesPane
      driveId={stage.driveId}
      selectedPageId={stage.object?.kind === 'page' ? stage.object.pageId : null}
      selectedConversationId={stage.object?.kind === 'conversation' ? stage.object.conversationId : null}
    />
  ) : null;

/** The list slot holds the section's list. */
const listFor = (stage: Stage, layout: PaneLayout): ReactNode =>
  isListSection(stage.section) && layout.list !== 'closed' ? (
    <ListPane
      section={stage.section}
      variant={layout.list}
      title={titles[stage.section]}
      closeHref={chatHref(stage)}
    >
      {rowsFor(stage)}
    </ListPane>
  ) : null;

/** The hamburger, while this section's list is hidden. */
const openerFor = (stage: Stage, layout: PaneLayout): ReactNode =>
  layout.listHidden && isListSection(stage.section) ? (
    <ListOpener section={stage.section} title={titles[stage.section]} />
  ) : null;

/**
 * The one persistent frame, mounted once by the (shell) layout. Routes are
 * addresses: the shell reads the URL, derives the stage and moves its panes,
 * and the route's output fills only the object slot. The hamburger sits in
 * the leading slot of the middle section's header: the object when one is
 * open, else the chat.
 */
export function Shell({ children }: ShellProps) {
  const pathname = usePathname() ?? '/';
  const collapsedSections = useUiState(selectCollapsed);
  const stage = stageFor(pathname);
  const layout = paneLayout(stage, { collapsedSections });
  const opener = openerFor(stage, layout);
  const context = chatContextFor(stage);
  return renderShell({
    stage,
    layout,
    rail: (
      <div className="mt-auto">
        <SignOutButton />
      </div>
    ),
    list: listFor(stage, layout),
    object: (
      <section className={columnClass} aria-label={titles[stage.section]}>
        {renderPaneHeader({ title: titles[stage.section], leading: layout.object ? opener : null })}
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </section>
    ),
    chat: (
      <section className={columnClass} aria-label="Chat" data-density={context.density}>
        {renderPaneHeader({ title: context.contextLabel, leading: layout.object ? null : opener })}
        <div className="min-h-0 flex-1 overflow-y-auto" />
      </section>
    ),
  });
}
