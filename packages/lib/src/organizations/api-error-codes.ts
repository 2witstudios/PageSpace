/**
 * api-error-codes — the ONE machine-readable error convention of the org, wallet, seat and policy
 * routes (Review 3+4 P2-11(a)), so the UI maps a code to its copy and never parses a message.
 *
 * Every non-2xx JSON body from those routes is `{ error: <human message>, code: <one of these>,
 * ...extras }` (extras: `issues` on a validation 400, `blockers` on a wallet delete, `policy` on an
 * org-policy refusal, `driveIds` on an org delete). `reason` is never the machine key.
 *
 * The one deliberate exception: while organizations are dark the routes answer a bare
 * `{ error: 'Not found' }` 404, exactly as an unknown route would, so nothing reveals that orgs
 * exist. Billing being off is NOT dark: it answers `billing_unavailable`.
 *
 * Pure: a registry and a type, no IO.
 */

/** Codes any of the routes can answer. */
export const GENERIC_API_ERROR_CODES = [
  'invalid_request',
  'unauthorized',
  'token_scope_refused',
  'org_not_found',
  'insufficient_role',
  'not_found',
  'rate_limited',
  'internal_error',
  'billing_unavailable',
  'no_billing_customer',
  'billing_provider_unreachable',
  'email_verification_required',
] as const;

/** Organization, membership, ownership, invitation, domain and guest-approval codes. */
export const ORG_DOMAIN_ERROR_CODES = [
  // organization lifecycle
  'slug_taken',
  'owner_not_found',
  'owner_not_human',
  'not_owner',
  'missing_choice',
  'unknown_drive',
  'duplicate_choice',
  'drive_already_trashed',
  'transfer_target_not_member',
  // membership and ownership
  'target_not_member',
  'use_ownership_transfer',
  'use_leave',
  'already_owner',
  'not_member',
  // invitations and seats
  'already_member',
  'already_invited',
  'seats_full',
  'delivery_failed',
  'expired',
  'already_accepted',
  'email_mismatch',
  // policy and lapse
  'org_policy',
  'org_lapsed',
  // verified domains
  'invalid_domain',
  'public_email_domain',
  'already_added',
  'claimed_by_another_org',
  'domain_limit_reached',
  'proof_not_found',
  'link_expired',
  'already_verified',
  // guest approvals
  'not_a_link_request',
  'link_gone',
] as const;

/** Wallet, cap and spend-source codes (drive-wallet-service, wallet-access). */
export const WALLET_ERROR_CODES = [
  'mcp_token_cannot_move_money',
  'mcp_token_cannot_change_spend_source',
  'drive_moved',
  'no_org_pool',
  'no_wallet',
  'wallet_exists',
  'wallet_in_use',
  'wallet_not_available',
  'invalid_amount',
  'nothing_to_change',
  'same_wallet',
  'not_a_drive_wallet',
  'not_personal_wallet',
  'insufficient_funds',
  'donations_disabled',
  'billing_disabled',
  'not_a_consumer',
  'not_org_member',
] as const;

export const ORG_API_ERROR_CODES = [
  ...GENERIC_API_ERROR_CODES,
  ...ORG_DOMAIN_ERROR_CODES,
  ...WALLET_ERROR_CODES,
] as const;

export type OrgApiErrorCode = (typeof ORG_API_ERROR_CODES)[number];

const CODES: ReadonlySet<string> = new Set(ORG_API_ERROR_CODES);

/** Whether `value` is one of the codes the routes answer. */
export function isOrgApiErrorCode(value: unknown): value is OrgApiErrorCode {
  return typeof value === 'string' && CODES.has(value);
}
