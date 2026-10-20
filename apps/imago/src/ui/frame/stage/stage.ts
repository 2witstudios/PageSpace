/**
 * The slot between the rail and the object. `list` is the wide stage-2 pane;
 * `tree` is the same pane narrowed beside an open object (myimago ADR 0029).
 */
export type ListPane = 'closed' | 'list' | 'tree';

/** The drive tools under the spine's divider (SPEC v3 spine; IMC-1.4). */
export type DriveTool = 'calendar' | 'agents' | 'workflows' | 'activity' | 'members' | 'trash';

export const driveTools: readonly DriveTool[] = ['calendar', 'agents', 'workflows', 'activity', 'members', 'trash'];

export const isDriveTool = (segment: string): segment is DriveTool => (driveTools as readonly string[]).includes(segment);

/** The rail destination a stage belongs to; `account` is reached from the avatar. Each drive tool is a section of its own. */
export type Section = 'chat' | 'files' | 'messages' | 'tasks' | 'settings' | 'account' | 'notifications' | DriveTool;

/** What the middle pane holds. Pages (documents, channels, task lists) are drive-scoped. */
export type StageObject =
  | { readonly kind: 'page'; readonly pageId: string }
  | { readonly kind: 'conversation'; readonly conversationId: string }
  /** One of the Tasks pane's smart views, as the middle. */
  | { readonly kind: 'taskView'; readonly viewId: string }
  /** A drive tool's own screen, opened from its pane. */
  | { readonly kind: 'tool' }
  | { readonly kind: 'settings' }
  | { readonly kind: 'account' }
  | { readonly kind: 'notifications' };

/** The stage's drive tool, if it is on one. */
export const toolOf = (stage: Stage): DriveTool | null => (isDriveTool(stage.section) ? stage.section : null);

/** Each tool's spine name; the agents route is the Console. */
export const driveToolTitles: Readonly<Record<DriveTool, string>> = {
  calendar: 'Calendar',
  agents: 'Console',
  workflows: 'Workflows',
  activity: 'Activity',
  members: 'Members',
  trash: 'Trash',
};

/** Which panes are open, derived from the URL and nothing else. */
export type Stage = {
  /** The drive the URL names; null on the user-level routes (/dm, /account). */
  readonly driveId: string | null;
  readonly section: Section;
  readonly list: ListPane;
  readonly object: StageObject | null;
};

export type ChatDensity = 'roomy' | 'dense';

export type ChatContext = {
  readonly density: ChatDensity;
  readonly contextLabel: string;
  readonly placeholder: string;
};

export type PaneLayout = {
  readonly list: ListPane;
  /** The viewer hid this section's list: the shell shows the opener instead. */
  readonly listHidden: boolean;
  readonly object: boolean;
};

/** The sections whose stage has a list pane, and so the only ones that collapse. */
export type ListSection = 'files' | 'messages' | 'tasks';

const listSections: readonly string[] = ['files', 'messages', 'tasks'];

export const isListSection = (section: string): section is ListSection =>
  listSections.includes(section);

/**
 * Every section's left pane can be closed (SPEC v3.2: Close sidebar on every
 * left pane), each section remembered on its own.
 */
export type HideableSection = Section;

const sections: readonly string[] = ['chat', 'files', 'messages', 'tasks', 'settings', 'account', ...driveTools];

export const isHideableSection = (section: string): section is HideableSection => sections.includes(section);

/** A drive's Console (the agents tool), whose middle is the selected session's pane grid. */
export const isConsole = (stage: Stage): boolean => stage.driveId !== null && stage.section === 'agents';

/**
 * The stage the shell lays out. The Console follows the one rule like every section, but which
 * session is open rides the query string (`?workspace=`) so its live shells survive every pick,
 * and the route alone cannot say; the caller passes it. With none open the pane sits alone
 * beside Imago; with one open, its pane grid is the object and Imago docks beside it.
 */
export const consoleStage = (stage: Stage, sessionOpen: boolean): Stage =>
  isConsole(stage) && sessionOpen ? sectionStage(stage.driveId, stage.section, { kind: 'tool' }) : stage;

/** First segments that name a route, never a drive. */
const reserved: readonly string[] = ['dm', 'account', 'orgs', 'chat', 'settings', 'notifications', ...listSections];

/**
 * Drive, page and conversation ids are cuid2s. Anything else (dots, percent
 * escapes, spaces, a query) is not an id, so the URL claims no object for it
 * and nothing downstream ever fetches with it.
 */
const isId = (segment: string | undefined): segment is string =>
  segment !== undefined && /^[A-Za-z0-9_-]{1,128}$/.test(segment);

/** The chat's own list is its history of past chats. */
const root: Stage = { driveId: null, section: 'chat', list: 'list', object: null };

const driveChat = (driveId: string): Stage => ({
  driveId,
  section: 'chat',
  list: 'list',
  object: null,
});

/**
 * The one shape every rail destination shares. The section's own address opens its sidebar
 * alone, with Imago filling the middle; picking something in the sidebar opens it as the
 * object, the sidebar narrows to the tree and Imago docks beside it. Closing the object
 * comes back here (sectionIndexPath).
 */
const sectionStage = (driveId: string | null, section: Section, object: StageObject | null): Stage =>
  object === null
    ? { driveId, section, list: 'list', object }
    : { driveId, section, list: 'tree', object };

/** The segment under a single-screen tool that opens its screen as the object. */
export const toolViewSegment = 'view';

/** The segment under Tasks that opens a smart view as the object. */
export const taskViewSegment = 'view';

const userStage = (first: string, rest: readonly string[]): Stage => {
  const [id, ...extra] = rest;
  if (first === 'orgs') return sectionStage(null, 'account', { kind: 'account' });
  if (first === 'account') return sectionStage(null, 'account', id === undefined ? null : { kind: 'account' });
  if (extra.length > 0) return root;
  if (id === undefined) return sectionStage(null, 'messages', null);
  return isId(id) ? sectionStage(null, 'messages', { kind: 'conversation', conversationId: id }) : root;
};

/**
 * A tool's screen. Members holds one more segment (`all`, `invite` or a member); the Console's
 * session rides its query (consoleStage); every other tool is one screen at `view`, so any other
 * path is one no route holds (stage.test).
 */
const toolStage = (driveId: string, tool: DriveTool, rest: readonly string[]): Stage => {
  const [id, ...extra] = rest;
  if (id === undefined) return sectionStage(driveId, tool, null);
  if (extra.length > 0) return driveChat(driveId);
  if (tool === 'members') return isId(id) ? sectionStage(driveId, tool, { kind: 'tool' }) : driveChat(driveId);
  // The Console opens a session through its query string (consoleStage), never a sub-route.
  if (tool === 'agents') return driveChat(driveId);
  return id === toolViewSegment ? sectionStage(driveId, tool, { kind: 'tool' }) : driveChat(driveId);
};

const driveStage = (driveId: string, rest: readonly string[]): Stage => {
  const [section, id, ...extra] = rest;
  if (section === undefined) return driveChat(driveId);
  if (section === 'settings') {
    return sectionStage(driveId, 'settings', id === undefined ? null : { kind: 'settings' });
  }
  if (isDriveTool(section)) return toolStage(driveId, section, rest.slice(1));
  if (!isListSection(section)) return driveChat(driveId);
  if (section === 'tasks' && id === taskViewSegment) {
    const [viewId, ...beyond] = extra;
    return isId(viewId) && beyond.length === 0
      ? sectionStage(driveId, 'tasks', { kind: 'taskView', viewId })
      : driveChat(driveId);
  }
  if (extra.length > 0) return driveChat(driveId);
  if (id === undefined) return sectionStage(driveId, section, null);
  return isId(id) ? sectionStage(driveId, section, { kind: 'page', pageId: id }) : driveChat(driveId);
};

/**
 * The URL is the single source of truth for the stage. The shell never
 * remounts between stages; it reads this and moves its panes.
 *
 * `pathname` is basePath-relative, as Next's usePathname() returns it. A shape
 * no route claims falls back to its drive's chat, or to the root (which the
 * server sends on to the viewer's Home drive) when no drive is named.
 */
export const stageFor = (pathname: string): Stage => {
  if (!pathname.startsWith('/')) return root;
  const [first, ...rest] = pathname.split('/').filter(Boolean);
  if (first === undefined) return root;
  if (first === 'p' && isId(rest[0])) return { driveId: null, section: 'files', list: 'closed', object: { kind: 'page', pageId: rest[0] } };
  if (first === 'dm' || first === 'account' || first === 'orgs') return userStage(first, rest);
  if (first === 'notifications') {
    return rest.length === 0
      ? { driveId: null, section: 'notifications', list: 'closed', object: { kind: 'notifications' } }
      : root;
  }
  if (reserved.includes(first) || !isId(first)) return root;
  return driveStage(first, rest);
};

/**
 * Every left pane collapses in place with Close sidebar (SPEC v3.2): the chat's
 * history, a stage-2 list, the tree beside an object and the settings and
 * account navs alike. Only a stage with no pane has nothing to hide.
 */
const collapsible = (stage: Stage): boolean => stage.list !== 'closed';

/**
 * The panes to show, from the stage and the one piece of view state the URL
 * does not carry: which sections' lists the viewer hid. Per section, so
 * hiding the file tree never hides the messages list.
 */
export const paneLayout = (
  stage: Stage,
  { collapsedSections }: { readonly collapsedSections: readonly HideableSection[] },
): PaneLayout => {
  const listHidden =
    collapsible(stage) && isHideableSection(stage.section) && collapsedSections.includes(stage.section);
  return {
    list: listHidden ? 'closed' : stage.list,
    listHidden,
    object: stage.object !== null,
  };
};

const sectionNames: Readonly<Record<ListSection, string>> = {
  files: 'Files',
  messages: 'Messages',
  tasks: 'Tasks',
};

/** What a page is called before its name loads, by the section that opened it. */
const unnamedPage: Readonly<Record<ListSection, string>> = {
  files: 'this page',
  messages: 'this channel',
  tasks: 'this task list',
};

const capitalise = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

const named = (name: string | undefined): string | undefined =>
  name !== undefined && name.trim() !== '' ? name : undefined;

const objectName = (section: ListSection, object: StageObject, name: string | undefined): string => {
  if (name !== undefined) return name;
  return object.kind === 'conversation' ? 'this conversation' : unnamedPage[section];
};

/**
 * Whether something is open in the middle. The one test both the columns (where Imago sits) and
 * the chat's density read, so the chat is roomy exactly when it is the ground.
 */
export const hasObject = (stage: Stage): boolean => stage.object !== null;

const densityFor = (stage: Stage): ChatDensity => (hasObject(stage) ? 'dense' : 'roomy');

/** The section's own name, as its pane head and Imago's chip read it. */
const sectionTitle = (stage: Stage): string | null => {
  const tool = toolOf(stage);
  if (tool !== null) return driveToolTitles[tool];
  if (isListSection(stage.section)) return sectionNames[stage.section];
  if (stage.section === 'settings') return 'Drive settings';
  if (stage.section === 'account') return 'Account';
  if (stage.section === 'notifications') return 'Notifications';
  return null;
};

/**
 * What the one continuous chat is answering against, per stage. The URL
 * carries ids, not names, so the drive and object names come from the
 * caller once loaded; until then the label says what kind of thing it is.
 */
export const chatContextFor = (
  stage: Stage,
  names: { readonly drive?: string; readonly object?: string } = {},
): ChatContext => {
  const density = densityFor(stage);
  const drive = named(names.drive);
  const { object } = stage;
  const tool = toolOf(stage);
  if (tool !== null) {
    return { density, contextLabel: `${drive ?? 'Drive'} ${driveToolTitles[tool].toLowerCase()} in context`, placeholder: 'Ask anything…' };
  }
  if (stage.section === 'settings') {
    return { density, contextLabel: `${drive ?? 'Drive'} settings in context`, placeholder: 'Ask anything…' };
  }
  if (stage.section === 'account') {
    return { density, contextLabel: 'Account in context', placeholder: 'Ask anything…' };
  }
  if (stage.section === 'notifications') {
    return { density, contextLabel: 'Notifications in context', placeholder: 'Ask about your notifications…' };
  }
  // Only the list sections open pages and conversations (stageFor); a smart view reads as its section.
  if (object !== null && object.kind !== 'taskView' && isListSection(stage.section)) {
    const name = objectName(stage.section, object, named(names.object));
    return {
      density,
      contextLabel: `${capitalise(name)} in context`,
      placeholder: `Ask about ${name}…`,
    };
  }
  if (isListSection(stage.section)) {
    return {
      density,
      contextLabel: `${sectionNames[stage.section]} in context`,
      placeholder: stage.section === 'files' ? 'Ask across Files, or @mention a page' : `Ask about your ${stage.section}…`,
    };
  }
  return {
    density,
    contextLabel: `${drive ?? 'This drive'} in context`,
    placeholder: 'Ask anything…',
  };
};

/**
 * Imago's context chip (SPEC v3 assistant head): the bare name of what it answers about — the
 * open page (once its name loads), the screen, "Account", the section — and none on the chat
 * home, where the conversation itself is the context.
 */
export const chatChipFor = (stage: Stage, names: { readonly object?: string; readonly screen?: string }): string | null => {
  const { object } = stage;
  if (object?.kind === 'page' || object?.kind === 'conversation') return named(names.object) ?? null;
  if (object !== null && object.kind !== 'taskView') return named(names.screen) ?? sectionTitle(stage);
  return sectionTitle(stage);
};

/** The middle's title when it has no head of its own: the section's name. */
export const stageTitle = (stage: Stage): string => sectionTitle(stage) ?? 'Chat';
