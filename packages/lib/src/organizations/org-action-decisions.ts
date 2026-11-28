/**
 * Membership, AI, compute and integration policy decisions — pure (Spec POL-5, POL-8, POL-9, POL-10, POL-11).
 * No IO: a caller reads the org's policies (policy-reader.ts) at the moment of the decision and asks here. `null`
 * policies means there is no org (a personal drive, the global assistant), which no org policy restricts.
 *
 * Every refusal is the same shape as the sharing policies' (PolicyRefusal): 403, code `org_policy`, the policy key
 * and a message that says what was refused.
 */
import type { OrgRole } from '@pagespace/db/schema/organizations';
import { holdsOrgRole } from './authorize-core';
import type { ActorPolicy, OrgPolicies, OrgPolicyKey } from './policies-core';
import { policyRefusal as refuse, type PolicyDecision } from './sharing-decisions';

const MIN_ROLE: Readonly<Record<ActorPolicy, OrgRole>> = { admins: 'ADMIN', members: 'MEMBER' };

export type OrgActorAction = 'invite' | 'create_drive';

/**
 * POL-5: may a person with this org role do this org action? `admins` means Owner and Admins; `members` means every
 * member. An unknown setting or an unknown role fails closed.
 */
export function orgActorDecision(setting: ActorPolicy, role: OrgRole, action: OrgActorAction): PolicyDecision {
  const min = MIN_ROLE[setting];
  if (min !== undefined && holdsOrgRole(role, min)) return { ok: true };
  return action === 'invite'
    ? refuse('whoCanInvite', 'This organization lets only Owners and Admins invite people. Ask an Owner or Admin to send the invitation.')
    : refuse('whoCanCreateDrives', 'This organization lets only Owners and Admins create drives. Ask an Owner or Admin to create it.');
}

/**
 * POL-8: may this model, from this provider, be used in the org's drives? BOTH allowlists must allow. `null` means no
 * restriction; an empty list allows nothing (never everything). No org policies = unrestricted.
 */
export function modelDecision(policies: OrgPolicies | null, use: { modelId: string; provider: string }): PolicyDecision {
  return agentModelSaveDecision(policies, { provider: use.provider, modelId: use.modelId });
}

/**
 * POL-8 at the tool boundary: may a model run's tools read content governed by these policies? Judged by the provider
 * and model the run RESOLVED (what actually runs). A run that names no resolved pair is refused — it fails closed,
 * never passes — because its model cannot be shown to be allowed. Content with no org is never restricted.
 */
export function toolModelDecision(policies: OrgPolicies | null, run: { provider?: string; modelId?: string }): PolicyDecision {
  if (policies === null) return { ok: true };
  if (!run.provider || !run.modelId) return refuse('modelAllowlist', UNRESOLVED_MODEL_REFUSED);
  return modelDecision(policies, { provider: run.provider, modelId: run.modelId });
}

const UNRESOLVED_MODEL_REFUSED = "This organization only lets AI models it allows read its content, and this run's model could not be determined.";
const PROVIDER_REFUSED = "This organization doesn't allow that AI provider. Choose a model from an allowed provider.";
const MODEL_REFUSED = "This organization doesn't allow that AI model. Choose one of the models it allows.";

/**
 * POL-8 at save time: may an agent page in this org's drives store this provider/model? Only what the save SETS is
 * judged: an unset model runs a default at call time, where the provider factory judges it (modelDecision).
 */
export function agentModelSaveDecision(
  policies: OrgPolicies | null,
  saved: { provider: string | null; modelId: string | null },
): PolicyDecision {
  if (policies === null) return { ok: true };
  if (saved.provider !== null && policies.providerAllowlist !== null && !policies.providerAllowlist.includes(saved.provider)) {
    return refuse('providerAllowlist', PROVIDER_REFUSED);
  }
  if (saved.modelId !== null && policies.modelAllowlist !== null && !policies.modelAllowlist.includes(saved.modelId)) {
    return refuse('modelAllowlist', MODEL_REFUSED);
  }
  return { ok: true };
}

/** One provider of the model catalog, as the picker's catalog builder lists it. */
export interface ModelCatalogEntry {
  provider: string;
  /** Models are discovered at runtime (local providers), so the catalog lists none. */
  dynamic: boolean;
  models: readonly string[];
}

/**
 * POL-8, the picker: the models a drive offers. `null` = unrestricted (no org, or neither allowlist set). Otherwise
 * only allowed providers appear, each with its allowed models; a dynamic provider's value is the model allowlist
 * (null when only providers are restricted), which its runtime-discovered list is filtered by.
 */
export function allowedModelCatalog(
  policies: OrgPolicies | null,
  catalog: readonly ModelCatalogEntry[],
): Record<string, readonly string[] | null> | null {
  if (policies === null || (policies.modelAllowlist === null && policies.providerAllowlist === null)) return null;
  const { modelAllowlist, providerAllowlist } = policies;
  const allowed: Record<string, readonly string[] | null> = {};
  for (const entry of catalog) {
    if (providerAllowlist !== null && !providerAllowlist.includes(entry.provider)) continue;
    allowed[entry.provider] = entry.dynamic
      ? modelAllowlist
      : entry.models.filter((m) => modelDecision(policies, { provider: entry.provider, modelId: m }).ok);
  }
  return allowed;
}

/**
 * POL-8 for a person's background model call that reads content across their drives (memory discovery, pulse): the
 * drives whose content it may read. A drive whose org does not allow the model is left out; a drive with no org stays.
 */
export function drivesAllowingModel(
  drives: ReadonlyArray<{ driveId: string; policies: OrgPolicies | null }>,
  use: { modelId: string; provider: string },
): string[] {
  return drives.filter((d) => modelDecision(d.policies, use).ok).map((d) => d.driveId);
}

const switchDecision =(policies: OrgPolicies | null, key: Extract<OrgPolicyKey, 'agentsAutonomous' | 'crossDriveAgents' | 'cloudSandbox' | 'persistentEnvironments' | 'publishedApps'>, message: string): PolicyDecision =>
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

/**
 * POL-11, read where a connection is USED: may this connection act now? Either refuses: the provider is off the
 * org's allowlist, or the connection carries a suspension marker (set when it fell off the list). Both are checked
 * at the moment of use, so a connection whose marker is missing or stale is still refused, and one whose policy was
 * just widened but not yet reconciled stays refused until it is restored.
 */
export function integrationUsable(
  policies: OrgPolicies | null,
  providerSlug: string,
  connection: { suspendedByPolicy?: unknown },
): PolicyDecision {
  const listed = integrationDecision(policies, providerSlug);
  if (!listed.ok) return listed;
  if (connection.suspendedByPolicy !== null && connection.suspendedByPolicy !== undefined) {
    return refuse('integrationsAllowlist', "This organization doesn't allow that service right now. Ask an Owner or Admin which services are allowed.");
  }
  return { ok: true };
}

/** POL-11: may a drive connect or use this service (an integration provider slug)? `null` allowlist = any. */
export function integrationDecision(policies: OrgPolicies | null, providerSlug: string): PolicyDecision {
  if (policies === null || policies.integrationsAllowlist === null || policies.integrationsAllowlist.includes(providerSlug)) return { ok: true };
  return refuse('integrationsAllowlist', "This organization doesn't allow that service. Ask an Owner or Admin which services are allowed.");
}
