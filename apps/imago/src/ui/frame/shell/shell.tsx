'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import useSWR from 'swr';
import { useUiState } from '../../store/store';
import type { UiState } from '../../store/state';
import { ChatHistory } from '../../chat/chat-history/chat-history';
import { ChatPane } from '../../chat/chat-pane/chat-pane';
import { FilesPane } from '../../files/files-pane/files-pane';
import { MessagesPane } from '../../messages/messages-pane/messages-pane';
import { renderNewMessageLink } from '../../messages/messages-pane/messages-pane.render';
import { DmIndexPane } from '../../messages/dm-index/dm-index';
import { CommandPalette } from '../../palette/palette/palette';
import { NewTaskListAction, TasksPane } from '../../tasks/tasks-pane/tasks-pane';
import { TasksGround } from '../../tasks/tasks-ground/tasks-ground';
import { ToolPane } from '../tool-pane/tool-pane';
import { askLabelFor } from '../controls/ask-label';
import { AvatarMenu } from '../avatar-menu/avatar-menu';
import { BrandChip } from '../brand-chip/brand-chip';
import { DRIVES, driveStatus, drivesFrom, type DriveSummary } from '../drives/drives';
import { HomeDriveProvider } from '../drives/home-drive-context';
import { DRIVE_NOT_FOUND, renderNotFound } from '../not-found/not-found.render';
import { renderPaneHeader } from '../pane/pane-header';
import { ListPane } from '../list-pane/list-pane';
import { AskPill, ClosePage, CloseImago, CloseSidebar, CollapseImago, ShowSidebar } from '../controls/controls';
import { EmptyMiddle } from '../empty-middle/empty-middle';
import { PageHead } from '../../files/page-head/page-head';
import { ConversationHead } from '../../messages/dm-head/conversation-head';
import { AppBanner } from '../banners/app-banner';
import { TabBar } from '../tabs/tab-bar';
import { sectionPath } from '../tabs/tabs-model';
import { columnsFor, type Columns } from '../stage/columns';
import { AccountNavPane, DriveSettingsNavPane } from '../../settings/settings-nav/settings-nav-pane';
import { Rail } from '../rail/rail';
import { PhoneAsk } from '../phone/phone-ask';
import { PhoneBottomBar } from '../phone/phone-bar';
import { PhoneChatBack } from '../phone/phone-chat-back';
import { PhoneDocHead } from '../phone/phone-doc-head';
import { PhoneFilesHeader } from '../phone/phone-files-header';
import { phoneDocBodyClass } from '../phone/phone-doc-class';
import { renderPhoneShell } from '../phone/phone-shell.render';
import { useViewportTier } from '../viewport/use-viewport-tier';
import { driveHomeHref, railDrive } from '../rail/rail-items';
import {
  consoleGround,
  isConsole,
  isHideableSection,
  isTasksIndex,
  type HideableSection,
  isListSection,
  paneLayout,
  stageFor,
  type PaneLayout,
  type Section,
  type Stage,
} from '../stage/stage';
import { columnClass } from './shell-class';
import { dispatch, transactions } from '../../store/transactions';
import { renderShell } from './shell.render';
import { useHydrated } from './use-hydrated';
import { useDesktopFrame } from './desktop-frame';
import { RetainedSurface } from '@/retained-adapters/retained-provider';
import { OrgReauthenticationPrompt } from '@/retained/components/auth/OrgReauthenticationPrompt';
import { OrgSurfaceBanner } from '@/retained/components/orgs/OrgSurfaceBanner';
import { parseAgentSelection } from '@/retained/lib/agents/agent-selection';
import { SessionToolbar } from '../../tools/agents/session-toolbar';

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
  notifications: 'Notifications',
};

const selectCollapsed = (state: UiState) => state.resources.collapsedSections;
const selectPaneSheetOpen = (state: UiState) => state.resources.paneSheetOpen;
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
  paneSheet: false,
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

/** A section's head control, ahead of Close sidebar: a new list in Tasks, a new message in Messages. */
const headActionsFor = (stage: Stage): ReactNode => {
  if (stage.section === 'messages') return renderNewMessageLink();
  if (stage.section === 'tasks' && stage.driveId !== null) return <NewTaskListAction driveId={stage.driveId} />;
  return null;
};

/**
 * The left pane: the chat's history, a section's list or tree, or the settings and account
 * navs. Files draws its own pane, since its head carries New page beside Close sidebar.
 */
const listFor = (stage: Stage, layout: PaneLayout, phoneDrive?: { readonly name: string | null }): ReactNode => {
  if (layout.list === 'closed') return null;
  if (stage.section === 'chat') return <ChatHistory />;
  if (stage.section === 'settings' && stage.driveId !== null && stage.object?.kind === 'settings' && stage.object.tool !== undefined) {
    return <ToolPane tool={stage.object.tool} driveId={stage.driveId} close={<CloseSidebar section="settings" />} />;
  }
  if (stage.section === 'settings') return stage.driveId === null ? null : <DriveSettingsNavPane driveId={stage.driveId} />;
  if (stage.section === 'account') return <AccountNavPane />;
  if (!isListSection(stage.section)) return null;
  // The user-level /dm index: the Direct messages pane alone, with no drive's channels.
  if (stage.section === 'messages' && stage.driveId === null) {
    return (
      <DmIndexPane
        variant={layout.list}
        close={<CloseSidebar section="messages" />}
        selectedConversationId={stage.object?.kind === 'conversation' ? stage.object.conversationId : null}
      />
    );
  }
  if (stage.section === 'files' && stage.driveId !== null) {
    return (
      <FilesPane
        driveId={stage.driveId}
        selectedPageId={stage.object?.kind === 'page' ? stage.object.pageId : null}
        variant={layout.list}
        title={titles.files}
        phoneHeader={
          phoneDrive === undefined
            ? undefined
            : (newPage) => <PhoneFilesHeader driveName={phoneDrive.name} title={titles.files} newPage={newPage} />
        }
      />
    );
  }
  return (
    <ListPane section={stage.section} variant={layout.list} title={titles[stage.section]} actions={headActionsFor(stage)}>
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
  const { data } = useSWR<unknown>(DRIVES, { fallbackData: initialDrives });
  const drives = drivesFrom(data, homeDriveId);
  const routeStage = stageFor(pathname);
  // The Console's open session rides the query string; with none open, Imago holds its middle.
  const search = useSearchParams()?.toString() ?? '';
  const stage = consoleGround(routeStage, parseAgentSelection(search).sessionId !== null);
  const tier = useViewportTier();
  const phone = tier === 'phone';
  const paneSheetOpen = useUiState(selectPaneSheetOpen);
  // Navigating from the narrow pane sheet closes it, so the page it opened is not left covered.
  useEffect(() => {
    dispatch(transactions.closePaneSheet, undefined);
  }, [pathname]);
  // Below 1024px (not phone) the pane is a sheet: hidden until Show sidebar, whatever desktop remembers.
  const sheetSections = (): readonly HideableSection[] =>
    !isHideableSection(stage.section)
      ? collapsedSections
      : paneSheetOpen
        ? collapsedSections.filter((entry) => entry !== stage.section)
        : [...collapsedSections, stage.section];
  const effectiveCollapsed = tier === 'narrow' ? sheetSections() : collapsedSections;
  const missing = driveStatus(drives, stage.driveId) === 'missing';
  // A phone has no left pane to collapse: its list is a screen of its own.
  const layout = missing ? notFoundLayout : paneLayout(stage, { collapsedSections: phone ? [] : effectiveCollapsed });
  const columns = missing
    ? notFoundColumns
    : columnsFor(
        stage,
        {
          paneCollapsed: !phone && isHideableSection(stage.section) && effectiveCollapsed.includes(stage.section),
          imagoCollapsed,
          imagoClosed,
        },
        tier,
      );
  const drive = drives?.find((entry) => entry.id === stage.driveId);
  const title = missing ? 'Not found' : stage.object?.kind === 'settings' && stage.object.title ? stage.object.title : titles[stage.section];
  const hydrated = useHydrated();
  // Ask on a phone page opens Imago full-screen; it is the page it was asked on, so leaving the page ends it.
  const [askedAt, setAskedAt] = useState<string | null>(null);
  const desktopFrame = useDesktopFrame();
  const pageTrailing = (
    <span className="flex flex-none items-center gap-1">
      {columns.askPill ? <AskPill label={askLabelFor(stage)} /> : null}
      {columns.closePage ? <ClosePage href={sectionPath(stage)} /> : null}
    </span>
  );
  const objectColumn = (
    <section className={columnClass} aria-label={title}>
      {!missing && stage.object?.kind === 'page' ? (
        <PageHead pageId={stage.object.pageId} leading={opener(stage, columns, 'page')} trailing={pageTrailing} />
      ) : !missing && stage.object?.kind === 'conversation' ? (
        <ConversationHead conversationId={stage.object.conversationId} leading={opener(stage, columns, 'page')} trailing={pageTrailing} />
      ) : !missing && isConsole(stage) ? (
        // The open session's bar is the Console's head; it closes the session, not the route.
        <SessionToolbar
          driveId={stage.driveId ?? undefined}
          leading={opener(stage, columns, 'page')}
          trailing={columns.askPill ? <AskPill label={askLabelFor(stage)} /> : null}
        />
      ) : (
        renderPaneHeader({ title, leading: opener(stage, columns, 'page'), actions: missing ? null : pageTrailing })
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {missing ? renderNotFound({ ...DRIVE_NOT_FOUND, homeHref: homeHref(homeDriveId) }) : (
          <>
            {isTasksIndex(stage) && stage.driveId !== null ? <TasksGround driveId={stage.driveId} /> : null}
            {children}
          </>
        )}
      </div>
    </section>
  );
  const chatColumn = (
    <ChatPane
      stage={stage}
      driveName={drive?.name}
      homeDriveId={homeDriveId}
      leading={opener(stage, columns, 'imago')}
      trailing={columns.collapseImago ? <CollapseImago /> : columns.closeImago ? <CloseImago /> : null}
    />
  );
  if (phone) {
    const pageObject = !missing && stage.object?.kind === 'page' ? stage.object : null;
    const asking = pageObject !== null && askedAt === pathname;
    // A page on a phone: its 52px head over the body; the toolbar scrolls sideways (C-Resp-Phone-Doc).
    const phoneObject =
      pageObject === null ? (
        objectColumn
      ) : (
        <section className={columnClass} aria-label={title}>
          <PhoneDocHead stage={stage} pageId={pageObject.pageId} driveKey={railDrive(stage, homeDriveId) ?? 'home'} />
          <div className={`${phoneDocBodyClass} overflow-y-auto`}>{children}</div>
        </section>
      );
    // Full-screen Imago over the page, Back in its head (C-Resp-Phone-Chat).
    const phoneChat = (
      <ChatPane
        stage={stage}
        driveName={drive?.name}
        homeDriveId={homeDriveId}
        leading={pageObject === null ? null : <PhoneChatBack pageId={pageObject.pageId} onBack={() => setAskedAt(null)} />}
        trailing={null}
      />
    );
    // One column (C-Resp-Phone-Tree): the page the URL names; else the section's own screen.
    const onTree = stage.section === 'files' && stage.object === null && stage.driveId !== null && !missing;
    const listScreen = missing ? null : listFor(routeStage, layout, onTree ? { name: drive?.name ?? null } : undefined);
    const screen =
      asking
        ? phoneChat
        : stage.object !== null || missing
        ? phoneObject
        : stage.section === 'chat'
          ? chatColumn
          : (listScreen ?? objectColumn);
    return <HomeDriveProvider value={homeDriveId}>{renderPhoneShell({
      stage,
      hydrated,
      screen: <><RetainedSurface fill={false}><OrgSurfaceBanner /></RetainedSurface>{screen}</>,
      ask:
        onTree && stage.driveId !== null ? (
          <PhoneAsk href={`/${encodeURIComponent(stage.driveId)}`} />
        ) : pageObject !== null && !asking ? (
          <PhoneAsk onPress={() => setAskedAt(pathname)} />
        ) : null,
      bar: asking ? null : <PhoneBottomBar stage={routeStage} driveId={railDrive(stage, homeDriveId)} />,
      palette: <><CommandPalette stage={routeStage} homeDriveId={homeDriveId} drives={drives} /><RetainedSurface fill={false}><OrgReauthenticationPrompt /></RetainedSurface></>,
    })}</HomeDriveProvider>;
  }
  return <HomeDriveProvider value={homeDriveId}>{renderShell({
    stage,
    layout,
    columns,
    tier,
    onDismissImago: () => dispatch(transactions.collapseImago, undefined),
    onDismissPane: () => {
      if (isHideableSection(stage.section)) dispatch(transactions.collapseSection, stage.section);
    },
    hydrated,
    desktopFrame,
    rail: (
      <Rail
        stage={routeStage}
        layout={layout}
        homeDriveId={homeDriveId}
        brand={
          <BrandChip currentId={railDrive(stage, homeDriveId)} drives={drives} />
        }
        footer={<AvatarMenu active={stage.section === 'account'} />}
      />
    ),
    banner: <><AppBanner /><RetainedSurface fill={false}><OrgSurfaceBanner /></RetainedSurface></>,
    tabBar: <TabBar stage={routeStage} driveKey={railDrive(stage, homeDriveId) ?? 'home'} homeHref={driveHomeHref(railDrive(stage, homeDriveId))} />,
    list: missing ? null : listFor(routeStage, layout),
    object: objectColumn,
    chat: chatColumn,
    empty: <EmptyMiddle driveId={railDrive(stage, homeDriveId)} leading={opener(stage, columns, 'empty')} />,
    palette: <><CommandPalette stage={routeStage} homeDriveId={homeDriveId} drives={drives} /><RetainedSurface fill={false}><OrgReauthenticationPrompt /></RetainedSurface></>,
  })}</HomeDriveProvider>;
}
