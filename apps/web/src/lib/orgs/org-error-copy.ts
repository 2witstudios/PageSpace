/**
 * The ONE table that turns an org, wallet, seat or policy route's error `code` into the copy a
 * person sees (Review 3+4 P2-11(a)). Every org and wallet surface reads its refusal copy from here
 * and never parses the server's `error` message.
 *
 * Exhaustive over ORG_API_ERROR_CODES: a code added to the registry without copy fails tsc.
 * Credits are counts, so no line here carries a dollar sign.
 */
import { isOrgApiErrorCode, type OrgApiErrorCode } from '@pagespace/lib/organizations/api-error-codes';
import { ApiRequestError } from '@/lib/auth/auth-fetch';

export const ORG_ERROR_COPY: Record<OrgApiErrorCode, string> = {
  // generic
  invalid_request: 'Some of the details are not valid. Check them and try again.',
  unauthorized: 'Your session has ended. Sign in again to continue.',
  token_scope_refused: 'This access token is limited to specific drives, so it cannot do this.',
  org_not_found: 'This organization does not exist, or you are not a member of it.',
  insufficient_role: 'You do not have permission to do this.',
  not_found: 'That item no longer exists.',
  rate_limited: 'Too many attempts. Wait a moment and try again.',
  internal_error: 'Something went wrong on our side. Try again in a moment.',
  billing_unavailable: 'Billing is not available on this deployment.',
  no_billing_customer: 'This organization has no billing account yet.',
  billing_provider_unreachable: 'We could not reach the payment provider. Try again in a moment.',
  email_verification_required: 'Verify your email address first.',

  // organization lifecycle
  slug_taken: 'That organization URL is already taken. Choose another.',
  owner_not_found: 'The organization owner could not be found.',
  owner_not_human: 'An organization must be owned by a person.',
  not_owner: 'Only the Owner of this organization can do this.',
  missing_choice: 'Choose what happens to each drive first.',
  unknown_drive: 'One of the chosen drives is not part of this organization.',
  duplicate_choice: 'A drive was chosen more than once.',
  drive_already_trashed: 'That drive is already in the trash.',
  transfer_target_not_member: 'Drives can only be handed to a member of this organization.',

  // membership and ownership
  target_not_member: 'That person is not a member of this organization.',
  use_ownership_transfer: 'To change the Owner, transfer ownership instead.',
  use_leave: 'To remove yourself, leave the organization instead.',
  already_owner: 'That person is already the Owner.',
  not_member: 'You are not a member of this organization.',
  owner_must_transfer: 'Transfer ownership to another member before you leave.',

  // invitations and seats
  already_member: 'That person is already a member.',
  already_invited: 'That person already has a pending invitation.',
  seats_full: 'Every seat is in use. Add seats or turn on automatic seats to invite more people.',
  delivery_failed: 'The email could not be sent, so nothing was changed. Try again in a moment.',
  expired: 'This invitation has expired. Ask for a new one.',
  already_accepted: 'This invitation has already been accepted.',
  email_mismatch: 'This invitation was sent to a different email address.',

  // policy and lapse
  org_policy: 'An organization policy does not allow this.',
  org_lapsed: 'This organization is unpaid, so this is paused until an Owner or Admin reactivates it. Restricting access still works.',

  // verified domains
  invalid_domain: 'That is not a valid domain.',
  public_email_domain: 'Public email domains such as gmail.com cannot be verified.',
  already_added: 'That domain has already been added.',
  claimed_by_another_org: 'Another organization has already verified that domain.',
  domain_limit_reached: 'This organization has reached its limit of verified domains.',
  proof_not_found: 'We could not find the verification record yet. DNS changes can take a while.',
  link_expired: 'This verification link has expired. Send a new one.',
  already_verified: 'That domain is already verified.',

  // guest approvals
  not_a_link_request: 'This request can no longer be approved here.',
  link_gone: 'The share link for this request no longer exists.',
  not_a_page_grant: 'This request can no longer be approved here.',
  page_gone: 'The page for this request no longer exists.',

  // wallets, caps and spend sources
  mcp_token_cannot_move_money: 'Moving credits can only be done from the PageSpace app.',
  mcp_token_cannot_change_spend_source: 'The spending source can only be changed from the PageSpace app.',
  drive_moved: 'This drive moved to a different owner. Reload and try again.',
  no_org_pool: 'This organization has no credits pool yet.',
  no_wallet: 'This drive has no wallet.',
  wallet_exists: 'This drive already has a wallet.',
  wallet_in_use: 'This wallet has been used, so it cannot be deleted. Pause it instead.',
  wallet_not_available: 'That wallet is not available to you.',
  invalid_amount: 'Enter a whole number of credits, zero or more, within the allowed range for this action.',
  nothing_to_change: 'Nothing changed.',
  same_wallet: 'You cannot move credits from a wallet into itself.',
  not_a_drive_wallet: 'That is not a drive wallet.',
  not_personal_wallet: 'That is not your personal wallet.',
  insufficient_funds: 'There are not enough credits for this.',
  donations_disabled: 'This drive does not accept donations.',
  billing_disabled: 'Credits cannot be added on this deployment.',
  not_a_consumer: 'That person cannot spend in this drive.',
  not_org_member: 'That person is not a member of this organization.',
};

/** The registered `code` on an API refusal, or null for anything else. */
export function orgErrorCode(err: unknown): OrgApiErrorCode | null {
  if (!(err instanceof ApiRequestError)) return null;
  const body = err.body;
  if (body === null || typeof body !== 'object') return null;
  const code = (body as { code?: unknown }).code;
  return isOrgApiErrorCode(code) ? code : null;
}

/** The copy for an API refusal, or `fallback` when it carries no registered code. */
export function orgErrorMessage(err: unknown, fallback: string): string {
  const code = orgErrorCode(err);
  return code ? ORG_ERROR_COPY[code] : fallback;
}
