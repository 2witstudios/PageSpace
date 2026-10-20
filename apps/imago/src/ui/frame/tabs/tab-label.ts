import { isPageTypeValue, type PageTypeValue } from '@pagespace/lib/utils/enums';
import type { IconName } from '../../components/icon/icon-names';
import { isTaskViewId, viewFor } from '../../tasks/task-views/task-views';

/** What a tab's label is read from: the page API, the DM list, or the screen's nav name. */
export type TabLabel =
  | { readonly kind: 'page'; readonly pageId: string }
  | { readonly kind: 'conversation'; readonly conversationId: string }
  /** A drive tool carries its spine icon; every other screen draws the settings mark. */
  | { readonly kind: 'screen'; readonly title: string; readonly icon?: IconName }
  /** The drive's home: what a New tab shows until something opens in it. */
  | { readonly kind: 'home' };

const TOOLS: Readonly<Record<string, { readonly title: string; readonly icon: IconName }>> = {
  calendar: { title: 'Calendar', icon: 'calendar' },
  agents: { title: 'Console', icon: 'console' },
  workflows: { title: 'Workflows', icon: 'workflows' },
  activity: { title: 'Activity', icon: 'activity' },
  members: { title: 'Members', icon: 'members' },
  trash: { title: 'Trash', icon: 'trash' },
};

/** Drive settings, in the SPEC's nav names. */
const DRIVE_SETTINGS: Readonly<Record<string, string>> = {
  overview: 'Overview',
  general: 'General',
  roles: 'Members & roles',
  wallet: 'Wallet',
  integrations: 'Integrations',
  commands: 'Commands',
  context: 'Context',
  backups: 'Backups',
  domains: 'Domains',
  danger: 'Danger zone',
};

/** Account screens, in the SPEC's nav names (Profile lives at /account/profile; /account/account is its alias). */
const ACCOUNT: Readonly<Record<string, string>> = {
  overview: 'Overview',
  profile: 'Profile',
  account: 'Profile',
  display: 'Display',
  personalization: 'Personalization',
  notifications: 'Notifications',
  hotkeys: 'Hotkeys',
  privacy: 'Privacy',
  ai: 'AI providers',
  agents: 'Agents',
  'agent-accounts': 'Agent accounts',
  commands: 'Commands',
  plan: 'Plan',
  billing: 'Billing',
  usage: 'Usage',
  wallets: 'Wallets',
  storage: 'Storage',
  drives: 'Drives',
  organizations: 'Organizations',
  backups: 'Backups',
  trash: 'Trash',
  activity: 'Activity',
  connections: 'Connections',
  integrations: 'Integrations',
  mcp: 'MCP',
  'local-mcp': 'Local MCP',
  calendar: 'Calendar',
  messages: 'Messages',
  tasks: 'Tasks',
  legal: 'Legal',
};

const screen = (title: string | undefined, fallback: string): TabLabel => ({ kind: 'screen', title: title ?? fallback });

/**
 * A path segment, read raw when its percent-encoding is malformed: a mistyped URL or a
 * stored tab can hold one, and a throwing decode would take the tab bar down with it.
 */
const decode = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

/** A tab's label source, from its path alone. */
export const tabLabelFor = (path: string): TabLabel => {
  const [first = '', second = '', third = '', fourth = ''] = path.split('/').filter(Boolean).map(decode);
  if (first === 'p') return { kind: 'page', pageId: second };
  if (first === 'dm') return { kind: 'conversation', conversationId: second };
  if (first === 'orgs') return screen(third === 'drives' ? 'Drives' : ({ general: 'General', members: 'Members & seats', drives: 'Drives', policies: 'Policies', security: 'Security', billing: 'Plan & seats', audit: 'Audit log', attention: 'Needs your attention', danger: 'Danger zone' } as Readonly<Record<string, string>>)[fourth], 'Organization settings');
  if (first === 'account') return screen(ACCOUNT[second], 'Account');
  if (first === 'notifications') return screen('Notifications', 'Notifications');
  if (second === '') return { kind: 'home' };
  // A smart view is a screen of Tasks; every other Tasks object is a task list page.
  if (second === 'tasks' && third === 'view') return { kind: 'screen', title: isTaskViewId(fourth) ? viewFor(fourth).label : 'Tasks', icon: 'tasks' };
  if (second === 'files' || second === 'messages' || second === 'tasks') return { kind: 'page', pageId: third };
  if (second === 'settings') return screen(DRIVE_SETTINGS[third], 'Drive settings');
  const tool = TOOLS[second];
  return tool === undefined ? screen(undefined, 'Drive') : { kind: 'screen', title: tool.title, icon: tool.icon };
};

/** A page tab's title and type from GET /api/pages/[id]; channels read "#name" as the boards draw them. */
export const pageTabOf = (body: unknown): { readonly title: string; readonly type: PageTypeValue } | null => {
  if (typeof body !== 'object' || body === null) return null;
  const { title, type } = body as { readonly title?: unknown; readonly type?: unknown };
  if (typeof title !== 'string' || typeof type !== 'string' || !isPageTypeValue(type)) return null;
  return { title: type === 'CHANNEL' ? `#${title}` : title, type };
};
