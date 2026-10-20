import { TIER_PLAN_LIMITS, toSubscriptionTier } from '@pagespace/lib/billing/subscription-tiers';
import type { NavGroup } from '../settings-nav/settings-nav';

/** apps/web's account route: the viewer's own name, email and image (GET /api/account). */
export const ACCOUNT_ME = '/api/account';
/** apps/web's subscription status: the tier that names the plan (GET /api/subscriptions/status). */
export const SUBSCRIPTION_STATUS = '/api/subscriptions/status';
/** apps/web's credit balance: `spendable` is the whole-number total (GET /api/credits). */
export const CREDITS = '/api/credits';

export type Account = {
  readonly name: string;
  readonly email: string | null;
  readonly image: string | null;
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null;

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** The viewer's identity; null for an error body or nothing loaded yet. */
export const accountOf = (body: unknown): Account | null => {
  if (!isRecord(body)) return null;
  return { name: text(body.name) ?? text(body.email) ?? '', email: text(body.email), image: text(body.image) };
};

/** The plan's display name ("Pro"); a missing tier reads as Free, as the API does. */
export const planNameOf = (body: unknown): string | null => {
  if (!isRecord(body)) return null;
  return TIER_PLAN_LIMITS[toSubscriptionTier(text(body.subscriptionTier))].name;
};

/** Spendable credits as a whole number; null when the balance is not loaded. */
export const creditsOf = (body: unknown): number | null =>
  isRecord(body) && typeof body.spendable === 'number' && Number.isFinite(body.spendable)
    ? Math.floor(body.spendable)
    : null;

/** The number of drives the viewer can reach; null for an error body or nothing loaded yet. */
export const driveCountOf = (body: unknown): number | null => (Array.isArray(body) ? body.length : null);

/** One figure of the "At a glance" strip; a null value reads as a dash until it loads. */
export type GlanceRow = { readonly label: string; readonly value: string | null; readonly href: string };

/**
 * The strip's figures. Plan and credits exist only where billing is on (cloud); the drive count is
 * every viewer's. A figure whose route has not answered is null, never a made-up number.
 */
export const glanceRows = (input: {
  readonly billing: boolean;
  readonly status: unknown;
  readonly credits: unknown;
  readonly drives: unknown;
}): readonly GlanceRow[] => {
  const credits = creditsOf(input.credits);
  const drives = driveCountOf(input.drives);
  return [
    ...(input.billing ? [{ label: 'Plan', value: planNameOf(input.status), href: '/account/plan' }] : []),
    ...(input.billing
      ? [{ label: 'Your credits', value: credits === null ? null : `${credits} credits`, href: '/account/usage' }]
      : []),
    { label: 'Drives', value: drives === null ? null : String(drives), href: '/account/drives' },
  ];
};

/** The row descriptions of the account screens (IMC board C-Account-Index). Keyed by nav href. */
const DESCRIPTIONS: Readonly<Record<string, string>> = {
  '/account/profile': 'Name, sign-in, passkeys and devices',
  '/account/account': 'Name, sign-in, passkeys and devices',
  '/account/display': 'Interface elements and page defaults',
  '/account/personalization': 'Customize how AI interacts with you',
  '/account/notifications': 'Email and pop-up preferences',
  '/account/hotkeys': 'Customize keyboard shortcuts',
  '/account/privacy': 'Review or withdraw cookie consent',
  '/account/ai': 'What this deployment can use',
  '/account/agent-accounts': 'API keys Imago can use unseen',
  '/account/commands': 'Register pages as slash commands',
  '/account/plan': 'Your plan and what it includes',
  '/account/billing': 'Payment methods and invoices',
  '/account/usage': 'Credits, automations and storage',
  '/account/wallets': 'What your AI spending draws from',
  '/account/storage': 'Uploaded files and storage',
  '/account/drives': 'Create and manage drives',
  '/account/organizations': 'Organizations you belong to',
  '/account/backups': 'Snapshots of your drives',
  '/account/trash': 'Pages you trashed across drives',
  '/account/connections': 'People, invitations and DMs',
  '/account/integrations': 'External APIs for your assistants',
  '/account/integrations/google-calendar': 'Sync events with Google Calendar',
  '/account/mcp': 'Connect external tools to PageSpace',
  '/account/local-mcp': 'Servers running on this device',
  '/account/legal/oss-licenses': 'Privacy Policy, Terms, OSS notices',
};

export const describeAccountRow = (href: string): string | undefined => DESCRIPTIONS[href];

/** The overview lists the screens in the nav's groups, without the overview itself. */
export const overviewGroups = (groups: readonly NavGroup[]): readonly NavGroup[] =>
  groups
    .map((group) => ({ ...group, items: group.items.filter((item) => item.href !== '/account/overview') }))
    .filter((group) => group.items.length > 0);
