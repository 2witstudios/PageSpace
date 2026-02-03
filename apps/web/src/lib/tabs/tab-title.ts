/**
 * Tab Title Derivation
 * Parse paths and derive tab metadata (title, icon)
 */

export type PathType =
  | 'dashboard'
  | 'drive'
  | 'page'
  | 'drive-tasks'
  | 'drive-activity'
  | 'drive-members'
  | 'drive-settings'
  | 'drive-trash'
  | 'messages'
  | 'messages-conversation'
  | 'settings'
  | 'unknown';

export interface ParsedPath {
  type: PathType;
  driveId?: string;
  pageId?: string;
  conversationId?: string;
  settingsPage?: string;
  path?: string;
}

export interface TabMeta {
  title: string;
  iconName: string;
}

const DRIVE_SPECIAL_ROUTES = ['tasks', 'activity', 'members', 'settings', 'trash'] as const;

export const parseTabPath = (path: string): ParsedPath => {
  const segments = path.split('/').filter(Boolean);

  // /settings or /settings/subpage
  if (segments[0] === 'settings') {
    return {
      type: 'settings',
      settingsPage: segments[1],
    };
  }

  // Must start with /dashboard
  if (segments[0] !== 'dashboard') {
    return { type: 'unknown', path };
  }

  // /dashboard
  if (segments.length === 1) {
    return { type: 'dashboard' };
  }

  // /dashboard/messages or /dashboard/messages/[conversationId]
  if (segments[1] === 'messages') {
    if (segments[2]) {
      return {
        type: 'messages-conversation',
        conversationId: segments[2],
      };
    }
    return { type: 'messages' };
  }

  const driveId = segments[1];

  // /dashboard/[driveId]
  if (segments.length === 2) {
    return { type: 'drive', driveId };
  }

  const thirdSegment = segments[2];

  // /dashboard/[driveId]/[specialRoute]
  if (DRIVE_SPECIAL_ROUTES.includes(thirdSegment as typeof DRIVE_SPECIAL_ROUTES[number])) {
    const typeMap: Record<string, PathType> = {
      tasks: 'drive-tasks',
      activity: 'drive-activity',
      members: 'drive-members',
      settings: 'drive-settings',
      trash: 'drive-trash',
    };
    return {
      type: typeMap[thirdSegment],
      driveId,
    };
  }

  // /dashboard/[driveId]/[pageId]
  return {
    type: 'page',
    driveId,
    pageId: thirdSegment,
  };
};

const ACRONYMS = ['mcp', 'api', 'ai'] as const;

const formatSettingsPage = (str: string): string => {
  if (ACRONYMS.includes(str.toLowerCase() as typeof ACRONYMS[number])) {
    return str.toUpperCase();
  }
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
};

export const getStaticTabMeta = (parsed: ParsedPath): TabMeta | null => {
  switch (parsed.type) {
    case 'dashboard':
      return { title: 'Dashboard', iconName: 'LayoutDashboard' };

    case 'drive-tasks':
      return { title: 'Tasks', iconName: 'CheckSquare' };

    case 'drive-activity':
      return { title: 'Activity', iconName: 'Activity' };

    case 'drive-members':
      return { title: 'Members', iconName: 'Users' };

    case 'drive-settings':
      return { title: 'Settings', iconName: 'Settings' };

    case 'drive-trash':
      return { title: 'Trash', iconName: 'Trash2' };

    case 'messages':
      return { title: 'Messages', iconName: 'MessageSquare' };

    case 'messages-conversation':
      // Requires async lookup for conversation name
      return null;

    case 'settings':
      if (parsed.settingsPage) {
        return {
          title: `Settings - ${formatSettingsPage(parsed.settingsPage)}`,
          iconName: 'Settings',
        };
      }
      return { title: 'Settings', iconName: 'Settings' };

    case 'page':
    case 'drive':
      // Requires async lookup
      return null;

    case 'unknown':
      return {
        title: parsed.path ?? 'Unknown',
        iconName: 'File',
      };

    default:
      return { title: 'Unknown', iconName: 'File' };
  }
};
