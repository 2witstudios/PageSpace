/**
 * wallet-access — who may see and run a drive wallet (Spec SPEND-9, SPEND-10, UI-9, WAL-4).
 *
 * PURE: the caller (the drive-wallet service) loads the person's standing through the
 * permissions module (drive relationship, org role) and asks here. No route decides wallet
 * access on its own.
 *
 * Roles, strongest first:
 *   - org_admin: an Owner or Admin of the drive's org (ORG-4: full access on every org-owned
 *                drive). Sees every wallet field, the pool and the unallocated balance (SPEND-10).
 *   - lead:      the drive lead (drives.ownerId). Sees the wallet and spend by member (SPEND-10).
 *   - member:    an effective member of the drive who is in its org (or any member of a
 *                personal drive). A consumer: the remaining amount and their own cap (SPEND-9).
 *   - guest:     a drive member not in the drive's org (DRV-8). The consumer projection.
 *   - none:      no access to the drive (including an org member who has not joined a
 *                Restricted or Private org drive). Answered as 404.
 *
 * Money authority: on an ORG drive the drive wallet is funded by the org pool, so creating,
 * allocating, topping up and deleting it move org money and are for org admins only (A-1: the
 * org pool allocates into drive wallets). The lead runs it: pause (the kill switch, WAL-7) and
 * rules (fallback, donations on/off per WAL-4, the drive's default source per SPEND-3). On a
 * PERSONAL drive the lead's own wallet funds it, so the lead does everything. Anyone who can
 * see the drive may donate (WAL-4); the donation service re-checks visibility itself.
 */

export type WalletViewer = 'org_admin' | 'lead' | 'member' | 'guest' | 'none';

export const WALLET_ACTIONS = [
  'view',
  'view_spend_by_member',
  'create',
  'allocate',
  'top_up',
  'pause',
  'set_rules',
  'delete',
  'donate',
] as const;
export type WalletAction = (typeof WALLET_ACTIONS)[number];

/** A person's standing in one drive, as the permissions module answers it. */
export interface WalletStanding {
  /** The drive's org, or null for a personal drive. */
  orgId: string | null;
  /** The person leads the drive (drives.ownerId). */
  isLead: boolean;
  /** The person is an effective member of the drive (the one org-aware access model). */
  isDriveMember: boolean;
  /** Their accepted role in the drive's org; null when not in it (a pending invite is not a role). */
  orgRole: 'OWNER' | 'ADMIN' | 'MEMBER' | null;
}

export function walletViewerRole(standing: WalletStanding): WalletViewer {
  if (standing.orgId !== null && (standing.orgRole === 'OWNER' || standing.orgRole === 'ADMIN')) return 'org_admin';
  if (standing.isLead) return 'lead';
  if (!standing.isDriveMember) return 'none';
  if (standing.orgId !== null && standing.orgRole === null) return 'guest';
  return 'member';
}

const CONSUMER_ACTIONS: readonly WalletAction[] = ['view', 'donate'];
const ORG_LEAD_ACTIONS: readonly WalletAction[] = ['view', 'view_spend_by_member', 'pause', 'set_rules', 'donate'];

/** Every action `role` may take on a drive wallet, in WALLET_ACTIONS order. */
export function walletActionsFor(role: WalletViewer, drive: { orgDrive: boolean }): WalletAction[] {
  const allowed: readonly WalletAction[] =
    role === 'org_admin' ? WALLET_ACTIONS
      : role === 'lead' ? (drive.orgDrive ? ORG_LEAD_ACTIONS : WALLET_ACTIONS)
        : role === 'member' || role === 'guest' ? CONSUMER_ACTIONS
          : [];
  return WALLET_ACTIONS.filter((action) => allowed.includes(action));
}

export function mayTakeWalletAction(role: WalletViewer, action: WalletAction, drive: { orgDrive: boolean }): boolean {
  return walletActionsFor(role, drive).includes(action);
}

// ---------------------------------------------------------------------------
// The credential (D-OW-26)
// ---------------------------------------------------------------------------

/** How the caller authenticated: a real session, or a delegated MCP/CLI token. */
export type WalletCredential = 'session' | 'mcp';

/** Every write the wallet surfaces offer: each wallet action but `view`, and the source choices. */
export type WalletWrite =
  | Exclude<WalletAction, 'view' | 'view_spend_by_member'>
  | 'set_conversation_source'
  | 'set_default_source';

export interface CredentialRefusal {
  code: 'mcp_token_cannot_move_money' | 'mcp_token_cannot_change_spend_source';
  message: string;
}

/**
 * [D-OW-26] A delegated MCP/CLI token never moves money and never redirects spend: every
 * wallet write (create, allocate, top-up, donate, delete, pause, rules) and every source
 * choice (a conversation's source, the personal default) needs a real session. Changing a
 * source moves no money by itself, but it silently redirects every future call's spend — the
 * same harm one step removed — and a long-lived delegated token is the wrong authority for it.
 * Null when the credential may make the write (the role check still applies).
 */
export function credentialRefusalFor(credential: WalletCredential, write: WalletWrite): CredentialRefusal | null {
  if (credential === 'session') return null;
  if (write === 'set_conversation_source' || write === 'set_default_source') {
    return { code: 'mcp_token_cannot_change_spend_source', message: 'An access token cannot change what a conversation or account spends from; sign in to change it' };
  }
  return { code: 'mcp_token_cannot_move_money', message: 'An access token cannot move money or change a wallet; sign in to do this' };
}

/**
 * [D-OW-26] What a token may read of a drive wallet: exactly the consumer projection a member
 * or guest gets in a session (D-OW-5), whatever the person's own role — no pool balance, no
 * other person's spend, no funder. A session reads as its role.
 */
export function viewerForCredential(viewer: Exclude<WalletViewer, 'none'>, credential: WalletCredential): Exclude<WalletViewer, 'none'> {
  if (credential === 'session') return viewer;
  return viewer === 'guest' ? 'guest' : 'member';
}
