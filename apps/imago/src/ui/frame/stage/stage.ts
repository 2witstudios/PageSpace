/**
 * The slot between the rail and the object. `list` is the wide stage-2 pane;
 * `tree` is the same pane narrowed beside an open object (myimago ADR 0029).
 */
export type ListPane = 'closed' | 'list' | 'tree';

/** The rail destination a stage belongs to; `account` is reached from the avatar. */
export type Section = 'chat' | 'files' | 'messages' | 'tasks' | 'settings' | 'account' | 'notifications';

/** What the middle pane holds. Pages (documents, channels, task lists) are drive-scoped. */
export type StageObject =
  | { readonly kind: 'page'; readonly pageId: string }
  | { readonly kind: 'conversation'; readonly conversationId: string }
  | { readonly kind: 'settings'; readonly title?: string; readonly tool?: DriveTool }
  | { readonly kind: 'account' }
  | { readonly kind: 'notifications' };

/** The drive tools under the spine's divider (SPEC v3 spine; IMC-1.4). */
export type DriveTool = 'calendar' | 'agents' | 'workflows' | 'activity' | 'members' | 'trash';

export const driveTools: readonly DriveTool[] = ['calendar', 'agents', 'workflows', 'activity', 'members', 'trash'];

const isDriveTool = (segment: string): segment is DriveTool => (driveTools as readonly string[]).includes(segment);

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

const sections: readonly string[] = ['chat', 'files', 'messages', 'tasks', 'settings', 'account'];

export const isHideableSection = (section: string): section is HideableSection => sections.includes(section);

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

/** Files, messages (channels and DMs) and tasks share one shape. */
const listStage = (
  driveId: string | null,
  section: ListSection,
  object: StageObject | null,
): Stage =>
  object === null
    ? { driveId, section, list: 'list', object }
    : { driveId, section, list: 'tree', object };

const userStage = (first: string, rest: readonly string[]): Stage => {
  const [id, ...extra] = rest;
  if (first === 'account' || first === 'orgs') {
    return { driveId: null, section: 'account', list: 'tree', object: { kind: 'account' } };
  }
  if (extra.length > 0) return root;
  if (id === undefined) return listStage(null, 'messages', null);
  return isId(id) ? listStage(null, 'messages', { kind: 'conversation', conversationId: id }) : root;
};

const driveStage = (driveId: string, rest: readonly string[]): Stage => {
  const [section, id, ...extra] = rest;
  if (section === undefined) return driveChat(driveId);
  if (section === 'settings') {
    return { driveId, section: 'settings', list: 'tree', object: { kind: 'settings' } };
  }
  if (isDriveTool(section)) {
    // Only Members has sub-routes (a member profile, the invite form); every other
    // tool is one screen, so any deeper path is one no route holds (stage.test).
    if (section !== 'members' && id !== undefined) return driveChat(driveId);
    if (section === 'members' && extra.length > 0) return driveChat(driveId);
    return {
      driveId,
      section: 'settings',
      // Each tool has its 260px pane (C-Drive-Calendar … C-Members; Trash keeps the Files pane).
      list: 'tree',
      object: { kind: 'settings', title: section.charAt(0).toUpperCase() + section.slice(1), tool: section },
    };
  }
  if (extra.length > 0) return driveChat(driveId);
  if (!isListSection(section)) return driveChat(driveId);
  if (id === undefined) return listStage(driveId, section, null);
  return isId(id) ? listStage(driveId, section, { kind: 'page', pageId: id }) : driveChat(driveId);
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
 * What the one continuous chat is answering against, per stage. The URL
 * carries ids, not names, so the drive and object names come from the
 * caller once loaded; until then the label says what kind of thing it is.
 */
export const chatContextFor = (
  stage: Stage,
  names: { readonly drive?: string; readonly object?: string } = {},
): ChatContext => {
  const drive = named(names.drive);
  const { object } = stage;
  if (object?.kind === 'settings') {
    return {
      density: 'dense',
      contextLabel: `${drive ?? 'Drive'} ${(object.title ?? 'settings').toLowerCase()} in context`,
      placeholder: 'Ask anything…',
    };
  }
  if (object?.kind === 'account') {
    return { density: 'dense', contextLabel: 'Account in context', placeholder: 'Ask anything…' };
  }
  if (object?.kind === 'notifications') {
    return { density: 'dense', contextLabel: 'Notifications in context', placeholder: 'Ask about your notifications…' };
  }
  // Only the list sections open pages and conversations (stageFor).
  if (object !== null && isListSection(stage.section)) {
    const name = objectName(stage.section, object, named(names.object));
    return {
      density: 'dense',
      contextLabel: `${capitalise(name)} in context`,
      placeholder: `Ask about ${name}…`,
    };
  }
  if (isListSection(stage.section)) {
    return {
      density: 'roomy',
      contextLabel: `${sectionNames[stage.section]} in context`,
      placeholder: stage.section === 'files' ? 'Ask across Files, or @mention a page' : `Ask about your ${stage.section}…`,
    };
  }
  return {
    density: 'roomy',
    contextLabel: `${drive ?? 'This drive'} in context`,
    placeholder: 'Ask anything…',
  };
};

/**
 * Whether Imago starts folded to the Ask pill when a page of this type is entered (IMC-3.11): an
 * agent page keeps its own chat in the middle, so its side chat waits behind Ask. Only the entry
 * decides it; a viewer who reopens Imago is never folded back.
 */
export const imagoStartsCollapsed = (pageType: string | null | undefined): boolean => pageType === 'AI_CHAT';

/** The screens whose boards open with Imago folded to its Ask pill (C-Drive-Calendar, C-Drive-Activity, C-Account-Agents, -Calendar, -Legal, -Drives, -Activity, -BackupSnapshot). */
const foldedScreens: readonly RegExp[] = [
  /^\/[^/]+\/(calendar|activity)$/,
  /^\/account\/(agents|calendar|legal|drives|activity)$/,
  /^\/account\/backups\/[^/]+\/snapshot$/,
];

/** Whether entering this address folds Imago (pathname is basePath-relative, as usePathname returns it). */
export const imagoStartsCollapsedAt = (pathname: string): boolean => foldedScreens.some((pattern) => pattern.test(pathname));

/**
 * Imago's context chip (SPEC v3 assistant head): the bare name of what it answers about — the
 * open page (once its name loads), the screen, "Account", the section — and none on the chat
 * home, where the conversation itself is the context.
 */
export const chatChipFor = (stage: Stage, names: { readonly object?: string; readonly screen?: string }): string | null => {
  const { object } = stage;
  if (object?.kind === 'settings') return named(names.screen) ?? object.title ?? 'Drive settings';
  if (object?.kind === 'account') return named(names.screen) ?? 'Account';
  if (object?.kind === 'notifications') return 'Notifications';
  if (object !== null) return named(names.object) ?? null;
  return isListSection(stage.section) ? sectionNames[stage.section] : null;
};
