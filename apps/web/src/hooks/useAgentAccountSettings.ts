'use client';

import useSWR from 'swr';
import { ApiRequestError, fetchWithAuth } from '@/lib/auth/auth-fetch';
import { attemptStepUp } from '@/lib/auth/step-up-ceremony';

import type { SafeAccount } from '@pagespace/lib/agent-accounts/to-safe-account';

/** The account's permissions as `GET /api/agent-accounts/[id]` returns them (never a key, never versions). */
export type AgentAccountSettings = {
  readonly account: SafeAccount;
  readonly autoApprove: { readonly enabled: true; readonly maxUsesPerHour: number; readonly until: number | null } | null;
  readonly usesThisHour: number | null;
  readonly bindings: readonly { readonly agentPageId: string; readonly title: string | null; readonly boundAt: number }[];
  readonly delegations: readonly { readonly id: string; readonly agentPageId: string | null; readonly title: string | null; readonly expiresAt: number; readonly createdAt: number }[];
  readonly canBind: boolean;
};

export const agentAccountSettingsUrl = (accountId: string) => `/api/agent-accounts/${accountId}`;

const fetcher = async (url: string): Promise<AgentAccountSettings> => {
  const res = await fetchWithAuth(url);
  if (!res.ok) throw new Error(`Failed to fetch account settings: ${res.status}`);
  return ((await res.json()) as { settings: AgentAccountSettings }).settings;
};

export function useAgentAccountSettings(accountId: string | null) {
  const { data, error, isLoading, mutate } = useSWR<AgentAccountSettings>(accountId === null ? null : agentAccountSettingsUrl(accountId), fetcher, { revalidateOnFocus: false });
  return { settings: data ?? null, error, isLoading, mutate };
}

/**
 * A change waiting on a magic-link step-up: resumed by `AgentAccountsPanel` when the link brings the person back.
 * Kept in localStorage (the link usually opens in a NEW tab), for no longer than the link itself lives.
 */
export type PendingAccountChange = { readonly accountId: string; readonly method: 'PATCH' | 'POST'; readonly url: string; readonly body: Record<string, unknown> };
export const PENDING_CHANGE_TTL_MS = 10 * 60_000;
export const PENDING_ACCOUNT_CHANGE_KEY = 'pagespace:agent-account-pending-change';

/** The parked change, when one is waiting and has not expired; it is removed either way. */
export function takePendingAccountChange(now: number): PendingAccountChange | null {
  const raw = localStorage.getItem(PENDING_ACCOUNT_CHANGE_KEY);
  localStorage.removeItem(PENDING_ACCOUNT_CHANGE_KEY);
  if (raw === null) return null;
  try {
    const parked = JSON.parse(raw) as { change?: PendingAccountChange; expiresAt?: number };
    return parked.change !== undefined && typeof parked.expiresAt === 'number' && parked.expiresAt > now ? parked.change : null;
  } catch {
    return null;
  }
}

/** What a step-up for a change to this account is bound to (mirrors `agentAccountStepUpBinding` on the server). */
export const accountStepUpBinding = (accountId: string): Record<string, string> => ({ action: 'agent_account_widen', accountId });

export const refusalOf = (error: unknown): string => (error instanceof ApiRequestError ? error.message : '');

/**
 * Send a change; if the server says it widens (`step_up_required`), run the step-up ceremony bound to this
 * account and send it again with the grant. With no passkey, a magic link is emailed and the change is
 * parked in sessionStorage until the link returns (`awaiting_email`).
 */
export async function sendAccountChange<T>(change: PendingAccountChange, send: (body: Record<string, unknown>) => Promise<T>): Promise<T | 'awaiting_email'> {
  try {
    return await send(change.body);
  } catch (error) {
    if (!(error instanceof ApiRequestError) || error.status !== 401 || error.message !== 'step_up_required') throw error;
  }
  const next = `${window.location.pathname}${window.location.search}`;
  const attempt = await attemptStepUp(accountStepUpBinding(change.accountId), next);
  if (attempt.status === 'awaiting_email') {
    localStorage.setItem(PENDING_ACCOUNT_CHANGE_KEY, JSON.stringify({ change, expiresAt: Date.now() + PENDING_CHANGE_TTL_MS }));
    return 'awaiting_email';
  }
  return send({ ...change.body, stepUpToken: attempt.stepUpToken });
}
