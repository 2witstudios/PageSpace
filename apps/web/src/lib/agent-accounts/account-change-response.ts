/**
 * Shared plumbing for the agent-account change routes (slice 2): the step-up a
 * widening needs, and the one response shape every change returns.
 *
 * Step-up: the client sends a `stepUpToken` only after a change came back
 * `step_up_required`. The token is consumed here, bound to this account
 * (`agentAccountStepUpBinding`), and becomes the `StepUpProof` the authority
 * signs into the plane consent. A token that does not verify is refused
 * outright — it is never silently dropped to "no step-up".
 */
import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { consumeStepUpGrant } from '@pagespace/lib/auth/step-up-service';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
import type { AccountChangeResult, AccountSettings, StepUpProof } from '@pagespace/lib/agent-accounts/account-authority-executor';
import type { AccessActor } from '@pagespace/lib/permissions/access-actor';
import { db } from '@pagespace/db/db';
import { inArray } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { agentAccountStepUpBinding, CHANGE_REFUSAL_STATUS } from './account-request-schemas';

export type StepUpVerdict = { readonly ok: true; readonly proof: StepUpProof | null } | { readonly ok: false; readonly response: NextResponse };

export async function stepUpProofFor({ userId, accountId, token, actionBinding = agentAccountStepUpBinding(accountId) }: { readonly userId: string; readonly accountId: string; readonly token: string | undefined; readonly actionBinding?: Record<string, string> }): Promise<StepUpVerdict> {
  if (token === undefined) return { ok: true, proof: null };
  const consumed = await consumeStepUpGrant({ userId, token, actionBinding });
  if (!consumed.ok) return { ok: false, response: NextResponse.json({ error: 'step_up_required' }, { status: 401 }) };
  // The consent names the step-up by a digest of its single-use grant, never the grant itself.
  return { ok: true, proof: { challengeId: `stepup:${createHash('sha256').update(token).digest('hex').slice(0, 32)}` } };
}

export type AccountSettingsView = Omit<AccountSettings, 'bindings' | 'delegations'> & {
  readonly bindings: readonly (AccountSettings['bindings'][number] & { readonly title: string | null })[];
  readonly delegations: readonly (AccountSettings['delegations'][number] & { readonly title: string | null })[];
};

/** Settings with each agent page's title — only for pages the viewer can still see. */
async function withTitles(actor: AccessActor, settings: AccountSettings): Promise<AccountSettingsView> {
  const ids = [...new Set([...settings.bindings.map((b) => b.agentPageId), ...settings.delegations.flatMap((d) => (d.agentPageId === null ? [] : [d.agentPageId]))])];
  const rows = ids.length === 0 ? [] : await db.select({ id: pages.id, title: pages.title }).from(pages).where(inArray(pages.id, ids));
  const visible = new Map<string, string>();
  for (const row of rows) if (await canUserViewPage(actor, row.id)) visible.set(row.id, row.title);
  return {
    ...settings,
    bindings: settings.bindings.map((binding) => ({ ...binding, title: visible.get(binding.agentPageId) ?? null })),
    delegations: settings.delegations.map((delegation) => ({ ...delegation, title: delegation.agentPageId === null ? null : (visible.get(delegation.agentPageId) ?? null) })),
  };
}

export async function changeResponse(actor: AccessActor, result: AccountChangeResult): Promise<NextResponse> {
  if (!result.ok) return NextResponse.json({ error: result.reason }, { status: CHANGE_REFUSAL_STATUS[result.reason] ?? 400 });
  return NextResponse.json({ settings: await withTitles(actor, result.settings) });
}
