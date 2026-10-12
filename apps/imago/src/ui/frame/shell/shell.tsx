'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import useSWR from 'swr';
import { useUiState } from '../../store/store';
import type { UiState } from '../../store/state';
import { ChatHistory } from '../../chat/chat-history/chat-history';
import { ChatPane } from '../../chat/chat-pane/chat-pane';
import { FilesPane } from '../../files/files-pane/files-pane';
import { MessagesPane } from '../../messages/messages-pane/messages-pane';
import { CommandPalette } from '../../palette/palette/palette';
import { TasksPane } from '../../tasks/tasks-pane/tasks-pane';
import { AvatarMenu } from '../avatar-menu/avatar-menu';
import { BrandChip } from '../brand-chip/brand-chip';
import { DRIVES, driveStatus, drivesFrom, type DriveSummary } from '../drives/drives';
import { DRIVE_NOT_FOUND, renderNotFound } from '../not-found/not-found.render';
import { renderPaneHeader } from '../pane/pane-header';
import { ListPane } from '../list-pane/list-pane';
import { AskPill, ClosePage, CloseImago, CollapseImago, ShowSidebar } from '../controls/controls';
import { EmptyMiddle } from '../empty-middle/empty-middle';
import { TabBar } from '../tabs/tab-bar';
import { sectionPath } from '../tabs/tabs-model';
import { columnsFor, type Columns } from '../stage/columns';
import { AccountNavPane, DriveSettingsNavPane } from '../../settings/settings-nav/settings-nav-pane';
import { Rail } from '../rail/rail';
import { railDrive } from '../rail/rail-items';
import {
  isHideableSection,
  isListSection,
  paneLayout,
  stageFor,
  type PaneLayout,
  type Section,
  type Stage,
} from '../stage/stage';
import { columnClass } from './shell-class';
import { renderShell } from './shell.render';
import { useHydrated } from './use-hydrated';

export type ShellProps = {
  /** The route's page: it renders only the object's content. */
  readonly children: ReactNode;
  /** The viewer's Home drive, where the rail links from the driveless stages. */
  readonly homeDriveId: string | null;
  /** The viewer's drives as the server listed them for this page load; SWR revalidates them. */
  readonly initialDrives: readonly DriveSummary[];
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
const selectImagoCollapsed = (state: UiState) => state.resources.imagoCollapsed;
const selectImagoClosed = (state: UiState) => state.resources.imagoClosed;

/**
 * A drive the API does not list for the viewer (it lists every drive they
 * can reach): only the object column opens, holding the not-found object,
 * whatever section the address named.
 */
const notFoundLayout: PaneLayout = { list: 'closed', listHidden: false, object: true };

const notFoundColumns: Columns = {
  pane: false,
  page: true,
  imago: 'docked',
  showSidebarIn: null,
  askPill: false,
  collapseImago: true,
  closeImago: false,
  closePage: false,
};

const homeHref = (homeDriveId: string | null): string | null =>
  homeDriveId === null ? null : `/${encodeURIComponent(homeDriveId)}`;

/** A section's rows: channels and DMs in Messages, the drive's task lists in Tasks. */
const rowsFor = (stage: Stage): ReactNode => {
  if (stage.section === 'messages') {
    return (
      <MessagesPane
        driveId={stage.driveId}
        selectedPageId={stage.object?.kind === 'page' ? stage.object.pageId : null}
        selectedConversationId={stage.object?.kind === 'conversation' ? stage.object.conversationId : null}
      />
    );
  }
  if (stage.section === 'tasks' && stage.driveId !== null) {
    return (
      <TasksPane
        driveId={stage.driveId}
        selectedPageId={stage.object?.kind === 'page' ? stage.object.pageId : null}
      />
    );
  }
  return null;
};

/**
 * The left pane: the chat's history, a section's list or tree, or the settings and account
 * navs. Files draws its own pane, since its head carries New page beside Close sidebar.
 */
const listFor = (stage: Stage, layout: PaneLayout): ReactNode => {
  if (layout.list === 'closed') return null;
  if (stage.section === 'chat') return <ChatHistory />;
  if (stage.section === 'settings') return stage.driveId === null ? null : <DriveSettingsNavPane driveId={stage.driveId} />;
  if (stage.section === 'account') return <AccountNavPane />;
  if (!isListSection(stage.section)) return null;
  if (stage.section === 'files' && stage.driveId !== null) {
    return (
      <FilesPane
        driveId={stage.driveId}
        selectedPageId={stage.object?.kind === 'page' ? stage.object.pageId : null}
        variant={layout.list}
        title={titles.files}
      />
    );
  }
  return (
    <ListPane section={stage.section} variant={layout.list} title={titles[stage.section]}>
      {rowsFor(stage)}
    </ListPane>
  );
};

/** Show sidebar, in whichever head comes first while the pane is closed. */
const opener = (stage: Stage, columns: Columns, at: Columns['showSidebarIn']): ReactNode =>
  columns.showSidebarIn === at && isHideableSection(stage.section) ? <ShowSidebar section={stage.section} /> : null;

/**
 * The one persistent frame, mounted once by the (shell) layout. Routes are
 * addresses: the shell reads the URL, derives the stage and moves its panes,
 * and the route's output fills only the object slot. The hamburger sits in
 * the leading slot of the object's header.
 */
export function Shell({ children, homeDriveId, initialDrives }: ShellProps) {
  const pathname = usePathname() ?? '/';
  const collapsedSections = useUiState(selectCollapsed);
  const imagoCollapsed = useUiState(selectImagoCollapsed);
  const imagoClosed = useUiState(selectImagoClosed);
  const { data, error } = useSWR<unknown>(DRIVES, { fallbackData: initialDrives });
  const drives = drivesFrom(data, homeDriveId);
  const stage = stageFor(pathname);
  const missing = driveStatus(drives, stage.driveId) === 'missing';
  const layout = missing ? notFoundLayout : paneLayout(stage, { collapsedSections });
  const columns = missing
    ? notFoundColumns
    : columnsFor(stage, {
        paneCollapsed: isHideableSection(stage.section) && collapsedSections.includes(stage.section),
        imagoCollapsed,
        imagoClosed,
      });
  const drive = drives?.find((entry) => entry.id === stage.driveId);
  const title = missing ? 'Not found' : stage.object?.kind === 'settings' && stage.object.title ? stage.object.title : titles[stage.section];
  const hydrated = useHydrated();
  return renderShell({
    stage,
    layout,
    columns,
    hydrated,
    rail: (
      <Rail
        stage={stage}
        layout={layout}
        homeDriveId={homeDriveId}
        brand={
          <BrandChip
            stage={stage}
            currentId={railDrive(stage, homeDriveId)}
            drives={drives}
            failed={error !== undefined}
          />
        }
        footer={<AvatarMenu active={stage.section === 'account'} />}
      />
    ),
    tabBar: <TabBar stage={stage} driveKey={railDrive(stage, homeDriveId) ?? 'home'} />,
    list: missing ? null : listFor(stage, layout),
    object: (
      <section className={columnClass} aria-label={title}>
        {renderPaneHeader({
          title,
          leading: opener(stage, columns, 'page'),
          actions: missing ? null : (
            <span className="flex flex-none items-center gap-1">
              {columns.askPill ? <AskPill /> : null}
              <ClosePage href={sectionPath(stage)} />
            </span>
          ),
        })}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {missing ? renderNotFound({ ...DRIVE_NOT_FOUND, homeHref: homeHref(homeDriveId) }) : children}
        </div>
      </section>
    ),
    chat: (
      <ChatPane
        stage={stage}
        driveName={drive?.name}
        homeDriveId={homeDriveId}
        leading={opener(stage, columns, 'imago')}
        trailing={columns.collapseImago ? <CollapseImago /> : columns.closeImago ? <CloseImago /> : null}
      />
    ),
    empty: <EmptyMiddle driveId={railDrive(stage, homeDriveId)} leading={opener(stage, columns, 'empty')} />,
    palette: <CommandPalette stage={stage} homeDriveId={homeDriveId} drives={drives} />,
  });
}
