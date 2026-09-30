/**
 * Membership, AI, compute and integration policy decisions — pure (Spec POL-5, POL-8, POL-9, POL-10, POL-11).
 * No IO: a caller reads the org's policies (policy-reader.ts) at the moment of the decision and asks here. `null`
 * policies means there is no org (a personal drive, the global assistant), which no org policy restricts.
 *
 * Every refusal is the same shape as the sharing policies' (PolicyRefusal): 403, code `org_policy`, the policy key
 * and a message that says what was refused.
 */
import type { OrgRole } from '@pagespace/db/schema/organizations';
import { ORG_ROLE_RANK } from './org-roles';
import type { ActorPolicy, OrgPolicies, OrgPolicyKey } from './policies-core';
import { ORG_POLICY_CODE, type PolicyDecision, type PolicyRefusal } from './sharing-decisions';

const refuse = (policy: OrgPolicyKey, message: string): PolicyRefusal => ({ ok: false, code: ORG_POLICY_CODE, policy, status: 403, message });

const MIN_ROLE: Readonly<Record<ActorPolicy, OrgRole>> = { admins: 'ADMIN', members: 'MEMBER' };

export type OrgActorAction = 'invite' | 'create_drive';

/**
 * POL-5: may a person with this org role do this org action? `admins` means Owner and Admins; `members` means every
 * member. An unknown setting or an unknown role fails closed.
 */
export function orgActorDecision(setting: ActorPolicy, role: OrgRole, action: OrgActorAction): PolicyDecision {
  const min = MIN_ROLE[setting];
  const rank = ORG_ROLE_RANK[role];
  if (min !== undefined && rank !== undefined && rank >= ORG_ROLE_RANK[min]) return { ok: true };
  return action === 'invite'
    ? refuse('whoCanInvite', 'This organization lets only Owners and Admins invite people. Ask an Owner or Admin to send the invitation.')
    : refuse('whoCanCreateDrives', 'This organization lets only Owners and Admins create drives. Ask an Owner or Admin to create it.');
}

/**
 * POL-8: may this model, from this provider, be used in the org's drives? BOTH allowlists must allow. `null` means no
 * restriction; an empty list allows nothing (never everything). No org policies = unrestricted.
 */
export function modelDecision(policies: OrgPolicies | null, use: { modelId: string; provider: string }): PolicyDecision {
  if (policies === null) return { ok: true };
  if (policies.providerAllowlist !== null && !policies.providerAllowlist.includes(use.provider)) {
    return refuse('providerAllowlist', "This organization doesn't allow that AI provider. Choose a model from an allowed provider.");
  }
  if (policies.modelAllowlist !== null && !policies.modelAllowlist.includes(use.modelId)) {
    return refuse('modelAllowlist', "This organization doesn't allow that AI model. Choose one of the models it allows.");
  }
  return { ok: true };
}

const switchDecision = (policies: OrgPolicies | null, key: Extract<OrgPolicyKey, 'agentsAutonomous' | 'crossDriveAgents' | 'cloudSandbox' | 'persistentEnvironments' | 'publishedApps'>, message: string): PolicyDecision =>
  policies === null || policies[key] ? { ok: true } : refuse(key, message);

/** POL-9: may agents run without a person present (mentions, triggers, workflows) in this org's drives? */
export const agentsAutonomousDecision = (policies: OrgPolicies | null): PolicyDecision =>
  switchDecision(policies, 'agentsAutonomous', "This organization doesn't let agents run on their own. An agent runs here only when a person asks it.");

/** POL-9: may an agent that lives in another drive be added to this org's drives? */
export const crossDriveAgentsDecision = (policies: OrgPolicies | null): PolicyDecision =>
  switchDecision(policies, 'crossDriveAgents', "This organization doesn't allow agents from other drives. Use an agent that lives in this drive.");

/** POL-10: may cloud sandboxes (code execution, the terminal) run in this org's drives? */
export const sandboxDecision = (policies: OrgPolicies | null): PolicyDecision =>
  switchDecision(policies, 'cloudSandbox', "This organization doesn't allow cloud sandboxes.");

/** POL-10: may persistent environments be created or started in this org's drives? */
export const environmentsDecision = (policies: OrgPolicies | null): PolicyDecision =>
  switchDecision(policies, 'persistentEnvironments', "This organization doesn't allow persistent environments.");

/** POL-10: may published apps be created or run in this org's drives? */
export const publishedAppsDecision = (policies: OrgPolicies | null): PolicyDecision =>
  switchDecision(policies, 'publishedApps', "This organization doesn't allow published apps.");

/** POL-11: may a drive connect or use this service (an integration provider slug)? `null` allowlist = any. */
export function integrationDecision(policies: OrgPolicies | null, providerSlug: string): PolicyDecision {
  if (policies === null || policies.integrationsAllowlist === null || policies.integrationsAllowlist.includes(providerSlug)) return { ok: true };
  return refuse('integrationsAllowlist', "This organization doesn't allow that service. Ask an Owner or Admin which services are allowed.");
}
