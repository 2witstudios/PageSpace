import { isPageTypeValue, type PageTypeValue } from '@pagespace/lib/utils/enums';

/** What a tab's label is read from: the page API, the DM list, or the screen's nav name. */
export type TabLabel =
  | { readonly kind: 'page'; readonly pageId: string }
  | { readonly kind: 'conversation'; readonly conversationId: string }
  | { readonly kind: 'screen'; readonly title: string };

const TOOLS: Readonly<Record<string, string>> = {
  calendar: 'Calendar',
  agents: 'Agents',
  workflows: 'Workflows',
  activity: 'Activity',
  members: 'Members',
  trash: 'Trash',
};

/** Drive settings, in the SPEC's nav names. */
const DRIVE_SETTINGS: Readonly<Record<string, string>> = {
  '': 'Overview',
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
  '': 'Overview',
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

/** A tab's label source, from its path alone. */
export const tabLabelFor = (path: string): TabLabel => {
  const [first = '', second = '', third = ''] = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (first === 'p') return { kind: 'page', pageId: second };
  if (first === 'dm') return { kind: 'conversation', conversationId: second };
  if (first === 'account') return screen(ACCOUNT[second], 'Account');
  if (first === 'notifications') return screen('Notifications', 'Notifications');
  if (second === 'files' || second === 'messages' || second === 'tasks') return { kind: 'page', pageId: third };
  if (second === 'settings') return screen(DRIVE_SETTINGS[third], 'Drive settings');
  return screen(TOOLS[second], 'Drive');
};

/** A page tab's title and type from GET /api/pages/[id]; channels read "#name" as the boards draw them. */
export const pageTabOf = (body: unknown): { readonly title: string; readonly type: PageTypeValue } | null => {
  if (typeof body !== 'object' || body === null) return null;
  const { title, type } = body as { readonly title?: unknown; readonly type?: unknown };
  if (typeof title !== 'string' || typeof type !== 'string' || !isPageTypeValue(type)) return null;
  return { title: type === 'CHANNEL' ? `#${title}` : title, type };
};
