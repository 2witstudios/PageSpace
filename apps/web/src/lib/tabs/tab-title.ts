/**
 * Tab Title Derivation
 * Parse paths and derive tab metadata (title, icon)
 */

export type PathType =
  | 'dashboard'
  | 'drive'
  | 'page'
  | 'public-page'
  // Drive-specific routes
  | 'drive-tasks'
  | 'drive-activity'
  | 'drive-members'
  | 'drive-members-invite'
  | 'drive-members-user'
  | 'drive-settings'
  | 'drive-trash'
  | 'drive-calendar'
  | 'drive-inbox'
  // Global dashboard routes
  | 'dashboard-tasks'
  | 'dashboard-activity'
  | 'dashboard-storage'
  | 'dashboard-trash'
  | 'dashboard-connections'
  | 'dashboard-calendar'
  // Inbox routes
  | 'inbox'
  | 'inbox-dm'
  | 'inbox-channel'
  | 'inbox-new'
  // Settings routes
  | 'settings'
  // Admin routes
  | 'admin'
  | 'admin-users'
  | 'admin-support'
  | 'admin-monitoring'
  | 'admin-audit-logs'
  | 'admin-global-prompt'
  | 'admin-tables'
  // Other standalone routes
  | 'account'
  | 'notifications'
  | 'friends'
  | 'unknown';

export interface ParsedPath {
  type: PathType;
  driveId?: string;
  pageId?: string;
  conversationId?: string;
  userId?: string;
  settingsPage?: string;
  settingsSubPage?: string;
  adminPage?: string;
  path?: string;
}

export interface TabMeta {
  title: string;
  iconName: string;
}

// Global dashboard routes (not drive-specific)
const GLOBAL_DASHBOARD_ROUTES = ['tasks', 'activity', 'storage', 'trash', 'connections', 'calendar', 'inbox'] as const;

// Drive-specific special routes
const DRIVE_SPECIAL_ROUTES = ['tasks', 'activity', 'members', 'settings', 'trash', 'calendar', 'inbox'] as const;

export const parseTabPath = (path: string): ParsedPath => {
  const segments = path.split('/').filter(Boolean);

  if (segments.length === 0) {
    return { type: 'unknown', path };
  }

  // /account
  if (segments[0] === 'account') {
    return { type: 'account' };
  }

  // /p/[pageId] - public page link
  if (segments[0] === 'p' && segments[1]) {
    return {
      type: 'public-page',
      pageId: segments[1],
    };
  }

  // /settings or /settings/subpage or /settings/subpage/subsubpage
  if (segments[0] === 'settings') {
    return {
      type: 'settings',
      settingsPage: segments[1],
      settingsSubPage: segments[2],
    };
  }

  // /admin or /admin/subpage
  if (segments[0] === 'admin') {
    if (segments.length === 1) {
      return { type: 'admin' };
    }
    const adminPage = segments[1];
    const adminTypeMap: Record<string, PathType> = {
      users: 'admin-users',
      support: 'admin-support',
      monitoring: 'admin-monitoring',
      'audit-logs': 'admin-audit-logs',
      'global-prompt': 'admin-global-prompt',
      tables: 'admin-tables',
    };
    if (adminTypeMap[adminPage]) {
      return {
        type: adminTypeMap[adminPage],
        adminPage,
      };
    }
    return { type: 'admin', adminPage };
  }

  // /notifications
  if (segments[0] === 'notifications') {
    return { type: 'notifications' };
  }

  // /friends
  if (segments[0] === 'friends') {
    return { type: 'friends' };
  }

  // Must start with /dashboard for remaining routes
  if (segments[0] !== 'dashboard') {
    return { type: 'unknown', path };
  }

  // /dashboard
  if (segments.length === 1) {
    return { type: 'dashboard' };
  }

  const secondSegment = segments[1];

  // Check if it's a global dashboard route first
  if (GLOBAL_DASHBOARD_ROUTES.includes(secondSegment as typeof GLOBAL_DASHBOARD_ROUTES[number])) {
    // /dashboard/inbox routes
    if (secondSegment === 'inbox') {
      // /dashboard/inbox/dm/[conversationId]
      if (segments[2] === 'dm' && segments[3]) {
        return {
          type: 'inbox-dm',
          conversationId: segments[3],
        };
      }
      // /dashboard/inbox/channel/[pageId]
      if (segments[2] === 'channel' && segments[3]) {
        return {
          type: 'inbox-channel',
          pageId: segments[3],
        };
      }
      // /dashboard/inbox/new
      if (segments[2] === 'new') {
        return { type: 'inbox-new' };
      }
      // /dashboard/inbox
      return { type: 'inbox' };
    }

    // Other global dashboard routes
    const globalTypeMap: Record<string, PathType> = {
      tasks: 'dashboard-tasks',
      activity: 'dashboard-activity',
      storage: 'dashboard-storage',
      trash: 'dashboard-trash',
      connections: 'dashboard-connections',
      calendar: 'dashboard-calendar',
    };
    return { type: globalTypeMap[secondSegment] };
  }

  // At this point, secondSegment is a driveId
  const driveId = secondSegment;

  // /dashboard/[driveId]
  if (segments.length === 2) {
    return { type: 'drive', driveId };
  }

  const thirdSegment = segments[2];

  // /dashboard/[driveId]/[specialRoute]
  if (DRIVE_SPECIAL_ROUTES.includes(thirdSegment as typeof DRIVE_SPECIAL_ROUTES[number])) {
    // Handle members sub-routes
    if (thirdSegment === 'members') {
      // /dashboard/[driveId]/members/invite
      if (segments[3] === 'invite') {
        return {
          type: 'drive-members-invite',
          driveId,
        };
      }
      // /dashboard/[driveId]/members/[userId]
      if (segments[3]) {
        return {
          type: 'drive-members-user',
          driveId,
          userId: segments[3],
        };
      }
      // /dashboard/[driveId]/members
      return {
        type: 'drive-members',
        driveId,
      };
    }

    const typeMap: Record<string, PathType> = {
      tasks: 'drive-tasks',
      activity: 'drive-activity',
      settings: 'drive-settings',
      trash: 'drive-trash',
      calendar: 'drive-calendar',
      inbox: 'drive-inbox',
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

const ACRONYMS = new Set(['mcp', 'api', 'ai']);

/**
 * Format a settings/admin page name for display.
 * Handles hyphenated names like "ai-api" -> "AI API" and "local-mcp" -> "Local MCP"
 */
const formatPageName = (str: string): string => {
  return str
    .split('-')
    .map((word) => {
      const lower = word.toLowerCase();
      if (ACRONYMS.has(lower)) {
        return word.toUpperCase();
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
};

export const getStaticTabMeta = (parsed: ParsedPath): TabMeta | null => {
  switch (parsed.type) {
    // Main dashboard
    case 'dashboard':
      return { title: 'Dashboard', iconName: 'LayoutDashboard' };

    // Global dashboard routes
    case 'dashboard-tasks':
      return { title: 'Tasks', iconName: 'CheckSquare' };

    case 'dashboard-activity':
      return { title: 'Activity', iconName: 'Activity' };

    case 'dashboard-storage':
      return { title: 'Storage', iconName: 'HardDrive' };

    case 'dashboard-trash':
      return { title: 'Trash', iconName: 'Trash2' };

    case 'dashboard-connections':
      return { title: 'Connections', iconName: 'Link' };

    case 'dashboard-calendar':
      return { title: 'Calendar', iconName: 'Calendar' };

    // Drive-specific routes
    case 'drive-tasks':
      return { title: 'Tasks', iconName: 'CheckSquare' };

    case 'drive-activity':
      return { title: 'Activity', iconName: 'Activity' };

    case 'drive-members':
      return { title: 'Members', iconName: 'Users' };

    case 'drive-members-invite':
      return { title: 'Invite Members', iconName: 'UserPlus' };

    case 'drive-members-user':
      // Could return a generic title or fetch user name
      return { title: 'Member', iconName: 'User' };

    case 'drive-settings':
      return { title: 'Drive Settings', iconName: 'Settings' };

    case 'drive-trash':
      return { title: 'Trash', iconName: 'Trash2' };

    case 'drive-calendar':
      return { title: 'Calendar', iconName: 'Calendar' };

    case 'drive-inbox':
      return { title: 'Inbox', iconName: 'Inbox' };

    // Global inbox routes
    case 'inbox':
      return { title: 'Inbox', iconName: 'Inbox' };

    case 'inbox-dm':
      // Requires async lookup for conversation name
      return null;

    case 'inbox-channel':
      // Requires async lookup for channel name
      return null;

    case 'inbox-new':
      return { title: 'New Message', iconName: 'PenSquare' };

    // Settings routes
    case 'settings':
      if (parsed.settingsPage && parsed.settingsSubPage) {
        // Nested settings like /settings/integrations/google-calendar
        return {
          title: `${formatPageName(parsed.settingsPage)} - ${formatPageName(parsed.settingsSubPage)}`,
          iconName: 'Settings',
        };
      }
      if (parsed.settingsPage) {
        return {
          title: formatPageName(parsed.settingsPage),
          iconName: 'Settings',
        };
      }
      return { title: 'Settings', iconName: 'Settings' };

    // Admin routes
    case 'admin':
      return { title: 'Admin', iconName: 'Shield' };

    case 'admin-users':
      return { title: 'Admin - Users', iconName: 'Users' };

    case 'admin-support':
      return { title: 'Admin - Support', iconName: 'LifeBuoy' };

    case 'admin-monitoring':
      return { title: 'Admin - Monitoring', iconName: 'Activity' };

    case 'admin-audit-logs':
      return { title: 'Admin - Audit Logs', iconName: 'FileText' };

    case 'admin-global-prompt':
      return { title: 'Admin - Global Prompt', iconName: 'MessageSquare' };

    case 'admin-tables':
      return { title: 'Admin - Tables', iconName: 'Table' };

    // Other standalone routes
    case 'account':
      return { title: 'Account', iconName: 'User' };

    case 'notifications':
      return { title: 'Notifications', iconName: 'Bell' };

    case 'friends':
      return { title: 'Friends', iconName: 'Users' };

    // Dynamic routes requiring async lookup
    case 'page':
    case 'drive':
    case 'public-page':
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
