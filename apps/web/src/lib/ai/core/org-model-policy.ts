/**
 * The I/O shell of the org model and provider allowlists (Spec POL-8) for everything other than running a call
 * (the provider factory judges every call): saving an agent page's model, the model list a drive offers, and the
 * drives a person's background model call may read. Each reads the drive's org policies NOW (no cache) and asks
 * the pure decisions in @pagespace/lib/organizations/org-action-decisions.
 *
 * SERVER-ONLY. The model catalog (which pulls in the monitoring module) is loaded only by offeredModels, so the page
 * mutation path that imports this module for every save does not carry it.
 */
import { db } from '@pagespace/db/db';
import { inArray } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { getDrivePolicies, getOrgPolicies, getDerivedPageOrgIds } from '@pagespace/lib/organizations/policy-reader';
import { getMemberDriveIds } from '@pagespace/lib/permissions/member-drives';
import type { AccessActor } from '@pagespace/lib/permissions/access-actor';
import {
  agentModelSaveDecision,
  allowedModelCatalog,
  drivesAllowingModel,
  modelDecision,
} from '@pagespace/lib/organizations/org-action-decisions';
import type { PolicyDecision } from '@pagespace/lib/organizations/sharing-decisions';

const policiesOf = async (driveId: string) => (await getDrivePolicies(driveId))?.policies ?? null;

/** May an agent page in this drive store this provider/model? Only what the save sets is judged. */
export async function agentModelSaveRefusal(
  driveId: string,
  saved: { provider?: string | null; modelId?: string | null },
): Promise<PolicyDecision> {
  return agentModelSaveDecision(await policiesOf(driveId), { provider: saved.provider || null, modelId: saved.modelId || null });
}

/** The models a drive offers its pickers: null = the whole catalog; otherwise provider → allowed models. */
export async function offeredModels(driveId: string | null): Promise<Record<string, readonly string[] | null> | null> {
  if (!driveId) return null;
  const { buildModelCatalog } = await import('./model-catalog');
  const catalog = buildModelCatalog().map((p) => ({ provider: p.provider, dynamic: p.dynamic, models: p.models.map((m) => m.id) }));
  return allowedModelCatalog(await policiesOf(driveId), catalog);
}

/** The retained contributing orgs whose current policy allows this model. */
export async function orgsReadableByModel(
  use: { provider: string; modelId: string },
  orgIds: readonly string[],
): Promise<string[]> {
  const decisions = await Promise.all([...new Set(orgIds)].map(async (orgId) => ({
    orgId, allowed: modelDecision(await getOrgPolicies(orgId), use).ok,
  })));
  return decisions.filter(({ allowed }) => allowed).map(({ orgId }) => orgId);
}

/**
 * The part of a person's scope a background call on this model (memory discovery, pulse) may read: their drives
 * whose org allows the model, and their accessible pages that live in one. Such a call runs in no drive and spends
 * personal credits (SPEND-8), but it reads org content, so each org's allowlist still decides whether ITS content
 * may reach the model: a drive whose org does not allow it is left out, never the whole call refused.
 */
export async function scopeReadableByModel(
  use: { provider: string; modelId: string },
  scope: { driveIds: readonly string[]; pageIds?: readonly string[] },
): Promise<{ driveIds: string[]; pageIds: string[] }> {
  const pageIds = scope.pageIds ?? [];
  const pageDrives = pageIds.length > 0
    ? await db.select({ id: pages.id, driveId: pages.driveId }).from(pages).where(inArray(pages.id, [...pageIds]))
    : [];
  const candidates = [...new Set([...scope.driveIds, ...pageDrives.map((p) => p.driveId)])];
  const drives = await Promise.all(candidates.map(async (driveId) => ({ driveId, policies: await policiesOf(driveId) })));
  const readable = new Set(drivesAllowingModel(drives, use));
  const derived = await getDerivedPageOrgIds(pageIds);
  const readableOrgs = new Set(await orgsReadableByModel(use, [...derived.values()].flat()));
  return {
    driveIds: scope.driveIds.filter((id) => readable.has(id)),
    pageIds: pageDrives.filter((p) => readable.has(p.driveId) && (derived.get(p.id) ?? []).every((id) => readableOrgs.has(id))).map((p) => p.id),
  };
}

/**
 * A person's member drives a model may read, and whether that is ALL of them. Content that carries no drive — the
 * person's global-assistant conversations — may hold any of those orgs' content, so it may reach the model only when
 * `allReadable` (every org the person is in allows it). The one rule memory discovery and a global-assistant voice
 * call's replayed history both follow.
 */
export async function memberDrivesReadableByModel(
  actor: AccessActor,
  use: { provider: string; modelId: string },
): Promise<{ driveIds: string[]; allReadable: boolean }> {
  const memberDriveIds = await getMemberDriveIds(actor, { includeTrashed: true });
  const { driveIds } = await scopeReadableByModel(use, { driveIds: memberDriveIds });
  return { driveIds, allReadable: driveIds.length === memberDriveIds.length };
}
