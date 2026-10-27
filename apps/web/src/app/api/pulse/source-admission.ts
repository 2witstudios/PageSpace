import { db } from '@pagespace/db/db';
import { and, desc, eq, inArray } from '@pagespace/db/operators';
import { pulseSummaries } from '@pagespace/db/schema/dashboard';
import type { AccessActor } from '@pagespace/lib/permissions/access-actor';
import { checkDerivedContentAccess } from '@pagespace/lib/permissions/org-derived-content';
import { orgsReadableByModel } from '@/lib/ai/core/org-model-policy';

/** Reusable summaries retain their source orgs: admit every contributor before loading text for a model. */
export async function readReusablePulseSummaries(
  actor: AccessActor,
  model: Parameters<typeof orgsReadableByModel>[0],
) {
  const candidates = await db.select({ id: pulseSummaries.id, orgIds: pulseSummaries.orgIds })
    .from(pulseSummaries).where(eq(pulseSummaries.userId, actor.userId))
    .orderBy(desc(pulseSummaries.generatedAt)).limit(5);
  if (candidates.length === 0) return [];
  const readableOrgs = new Set(await orgsReadableByModel(model, candidates.flatMap(({ orgIds }) => orgIds)));
  const decisions = await Promise.all(candidates.map(async (candidate) => ({
    ...candidate,
    admitted: candidate.orgIds.every((id) => readableOrgs.has(id))
      && (await checkDerivedContentAccess(actor, candidate.orgIds)).allowed,
  })));
  const admittedIds = decisions.filter(({ admitted }) => admitted).map(({ id }) => id);
  if (admittedIds.length === 0) return [];
  return db.select({ summary: pulseSummaries.summary, generatedAt: pulseSummaries.generatedAt, orgIds: pulseSummaries.orgIds })
    .from(pulseSummaries).where(and(eq(pulseSummaries.userId, actor.userId), inArray(pulseSummaries.id, admittedIds)))
    .orderBy(desc(pulseSummaries.generatedAt));
}
