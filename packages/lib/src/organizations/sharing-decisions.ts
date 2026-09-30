/**
 * Sharing policy decisions — pure (Spec POL-2, POL-3, POL-4). No IO: a caller reads the org's policies
 * (policy-reader.ts) for the drive it is acting in and asks here. `null` policies means the drive has no org
 * (a personal drive), which no org policy ever restricts.
 *
 * A refusal always names the policy, so the caller can answer with the rule that stopped it, and carries a
 * status so every route answers the same way.
 */
import type { SuspensionKind } from '@pagespace/db/schema/organizations';
import type { OrgPolicies, OrgPolicyKey } from './policies-core';

export const ORG_POLICY_CODE = 'org_policy' as const;

export type PolicyRefusal = {
  ok: false;
  code: typeof ORG_POLICY_CODE;
  policy: OrgPolicyKey;
  status: 403;
  message: string;
};
export type PolicyDecision = { ok: true } | PolicyRefusal;

const refuse = (policy: OrgPolicyKey, message: string): PolicyRefusal => ({ ok: false, code: ORG_POLICY_CODE, policy, status: 403, message });

export const SHARE_LINKS_OFF_MESSAGE = "This organization doesn't allow public share links. Existing links are paused, not deleted.";
export const PUBLISHING_OFF_MESSAGE = "This organization doesn't allow publishing to the web. Existing published pages are paused, not deleted.";
export const CUSTOM_DOMAINS_OFF_MESSAGE = "This organization doesn't allow custom domains. Existing domains are paused, not deleted.";

export const GUESTS_OFF_MESSAGE = "This organization doesn't allow guests from outside it. People who are not members cannot be added to its drives.";
export const GUESTS_HELD_MESSAGE = 'This organization requires an Owner or Admin to approve guests from outside it. The request is waiting for approval and nothing has been granted yet.';

/** POL-2: the refusal a guest admission answers when the policy is off. */
export function guestsOffRefusal(): PolicyRefusal {
  return refuse('guests', GUESTS_OFF_MESSAGE);
}

/** POL-3: may a public share link be created in this drive? */
export function shareLinkCreationDecision(policies: OrgPolicies | null): PolicyDecision {
  return policies === null || policies.publicShareLinks ? { ok: true } : refuse('publicShareLinks', SHARE_LINKS_OFF_MESSAGE);
}

/**
 * POL-3: may this link be REDEEMED now? Two independent conditions, either refuses: the policy is off, or the
 * link carries a suspension marker (set when the policy turned off). Checking both at the moment of redemption is
 * what makes the suspension hold even for a link whose marker is missing or stale, and for a marker that outlives
 * a policy someone has just turned back on but not yet reconciled.
 */
export function shareLinkUsable(policies: OrgPolicies | null, link: { suspendedByPolicy: SuspensionKind | null }): boolean {
  if (link.suspendedByPolicy !== null) return false;
  return policies === null || policies.publicShareLinks;
}

/** POL-4: may a page be published to the web from this drive? */
export function publishingDecision(policies: OrgPolicies | null): PolicyDecision {
  return policies === null || policies.publishWeb ? { ok: true } : refuse('publishWeb', PUBLISHING_OFF_MESSAGE);
}

/** POL-4: may a custom domain be added to this drive? */
export function customDomainsDecision(policies: OrgPolicies | null): PolicyDecision {
  return policies === null || policies.customDomains ? { ok: true } : refuse('customDomains', CUSTOM_DOMAINS_OFF_MESSAGE);
}

/** What happens to a person being added to an org drive (POL-2). */
export type GuestAdmission = 'allow' | 'hold' | 'refuse';

/**
 * POL-2: an org MEMBER is never a guest. An outsider is refused when guests are off, held for an Owner or Admin
 * to approve when the policy is `approve`, and allowed when on. A drive with no org has no guest policy.
 */
export function decideGuestAdmission(policies: OrgPolicies | null, who: { isOrgMember: boolean }): GuestAdmission {
  if (policies === null || who.isOrgMember) return 'allow';
  switch (policies.guests) {
    case 'off':
      return 'refuse';
    case 'approve':
      return 'hold';
    case 'on':
      return 'allow';
  }
}
