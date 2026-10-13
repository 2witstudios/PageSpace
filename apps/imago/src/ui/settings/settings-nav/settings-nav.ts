/** One row of a settings nav pane (SPEC v3 "Settings navs (fixed order)"). */
export type NavItem = { readonly label: string; readonly href: string };
export type NavGroup = { readonly label: string; readonly items: readonly NavItem[] };

/** What the build and the viewer allow (classic's settings-visibility rules, plus the v3 gates). */
export type NavContext = {
  /** The desktop app: Local MCP. */
  readonly isDesktop: boolean;
  /** isBillingEnabled and not a store-reviewed native app: Plan and Billing. */
  readonly showBilling: boolean;
  readonly isNative: boolean;
  /** isOnPrem(): no external integrations (Integrations, Google Calendar). */
  readonly onPrem: boolean;
  /** ORGS_ENABLED (pu/ow-final-seats-money): Wallet, Wallets, Organizations. */
  readonly orgs: boolean;
};

type Gated = NavItem & { readonly when?: (ctx: NavContext) => boolean };

const keep = (items: readonly Gated[], ctx: NavContext): readonly NavItem[] =>
  items.filter((item) => item.when?.(ctx) ?? true).map(({ label, href }) => ({ label, href }));

const orgs = (ctx: NavContext) => ctx.orgs;
const integrations = (ctx: NavContext) => !ctx.onPrem;
const billing = (ctx: NavContext) => ctx.showBilling;

/** Who the viewer is in this drive: owners and admins manage it; the owner alone may delete it, and never a Home drive. */
export type DriveAccess = { readonly role: 'OWNER' | 'ADMIN' | 'MEMBER'; readonly home: boolean };

const ADMIN_ONLY = new Set(['General', 'Members & roles', 'Wallet', 'Integrations', 'Context', 'Backups', 'Domains']);

/**
 * Drive settings: Overview, General, Members & roles, Wallet, Integrations, Commands, Context, Backups, Domains, Danger zone.
 * Classic's gating: a plain member sees Overview and Commands; Danger zone is the owner's, and a Home drive has none.
 * With the access unknown (drives still loading), every row the build allows is shown and each route still refuses.
 */
export const driveSettingsNav = (driveId: string, ctx: NavContext, access?: DriveAccess): readonly NavItem[] => {
  const base = `/${encodeURIComponent(driveId)}/settings`;
  const admin = access === undefined || access.role !== 'MEMBER';
  const owner = access === undefined || (access.role === 'OWNER' && !access.home);
  return keep(
    [
      { label: 'Overview', href: base },
      { label: 'General', href: `${base}/general` },
      { label: 'Members & roles', href: `${base}/roles` },
      { label: 'Wallet', href: `${base}/wallet`, when: orgs },
      { label: 'Integrations', href: `${base}/integrations`, when: integrations },
      { label: 'Commands', href: `${base}/commands` },
      { label: 'Context', href: `${base}/context` },
      { label: 'Backups', href: `${base}/backups` },
      { label: 'Domains', href: `${base}/domains` },
      { label: 'Danger zone', href: `${base}/danger`, when: () => owner },
    ],
    ctx,
  ).filter((item) => admin || !ADMIN_ONLY.has(item.label));
};

/** The account's grouped nav: You · AI · Plan & data · Connections · Other, in the SPEC's order. */
export const accountNav = (ctx: NavContext): readonly NavGroup[] =>
  [
    {
      label: 'You',
      items: keep(
        [
          { label: 'Overview', href: '/account' },
          { label: 'Profile', href: '/account/profile' },
          { label: 'Display', href: '/account/display' },
          { label: 'Personalization', href: '/account/personalization' },
          { label: 'Notifications', href: '/account/notifications' },
          { label: 'Hotkeys', href: '/account/hotkeys' },
          { label: 'Privacy', href: '/account/privacy', when: (c: NavContext) => !c.isNative },
        ],
        ctx,
      ),
    },
    {
      label: 'AI',
      items: keep(
        [
          { label: 'AI providers', href: '/account/ai' },
          { label: 'Agents', href: '/account/agents' },
          { label: 'Agent accounts', href: '/account/agent-accounts' },
          { label: 'Commands', href: '/account/commands' },
        ],
        ctx,
      ),
    },
    {
      label: 'Plan & data',
      items: keep(
        [
          { label: 'Plan', href: '/account/plan', when: billing },
          { label: 'Billing', href: '/account/billing', when: billing },
          { label: 'Usage', href: '/account/usage' },
          { label: 'Wallets', href: '/account/wallets', when: orgs },
          { label: 'Storage', href: '/account/storage' },
          { label: 'Drives', href: '/account/drives' },
          { label: 'Organizations', href: '/account/organizations', when: orgs },
          { label: 'Backups', href: '/account/backups' },
          { label: 'Trash', href: '/account/trash' },
          { label: 'Activity', href: '/account/activity' },
        ],
        ctx,
      ),
    },
    {
      label: 'Connections',
      items: keep(
        [
          { label: 'Connections', href: '/account/connections' },
          { label: 'Integrations', href: '/account/integrations', when: integrations },
          { label: 'Google Calendar', href: '/account/integrations/google-calendar', when: integrations },
          { label: 'MCP', href: '/account/mcp' },
          { label: 'Local MCP', href: '/account/local-mcp', when: (c) => c.isDesktop },
          { label: 'Calendar', href: '/account/calendar' },
        ],
        ctx,
      ),
    },
    {
      label: 'Other',
      items: keep(
        [
          { label: 'Messages', href: '/account/messages' },
          { label: 'Tasks', href: '/account/tasks' },
          { label: 'Legal', href: '/account/legal' },
        ],
        ctx,
      ),
    },
  ].filter((group) => group.items.length > 0);

/**
 * The row the path belongs to: the longest href that is the path or its ancestor. A root row
 * (/account, /d1/settings) matches only itself, so it is not marked under every screen.
 */
export const activeNavHref = (items: readonly NavItem[], pathname: string): string | null => {
  const roots = new Set(items.filter((item) => !items.some((other) => other !== item && item.href.startsWith(`${other.href}/`))).map((item) => item.href));
  const matches = items.filter((item) =>
    pathname === item.href || (!roots.has(item.href) || item.href.split('/').length > 3 ? pathname.startsWith(`${item.href}/`) : false),
  );
  return matches.sort((a, b) => b.href.length - a.href.length)[0]?.href ?? null;
};
