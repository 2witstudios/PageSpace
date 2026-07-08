'use client';

import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import type { SubscriptionTier } from './types';

/**
 * Client helpers for the admin user-control routes. All mutations go through
 * fetchWithAuth (CSRF handled there) and throw an Error carrying the server's
 * message on failure.
 */
async function mutate<T = { success: boolean; message?: string }>(
  url: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  body?: unknown
): Promise<T> {
  const res = await fetchWithAuth(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null) as (T & { error?: string; message?: string }) | null;
  if (!res.ok) {
    throw new Error(data?.error ?? data?.message ?? `Request failed (${res.status})`);
  }
  return data as T;
}

export interface ActionResult {
  success: boolean;
  message?: string;
  revokedSessions?: number;
}

export function giftSubscription(userId: string, tier: Exclude<SubscriptionTier, 'free'>, reason: string) {
  return mutate<ActionResult>(`/api/admin/users/${userId}/gift-subscription`, 'POST', { tier, reason });
}

export function revokeSubscription(userId: string, reason: string, cancelAtPeriodEnd: boolean) {
  return mutate<ActionResult>(`/api/admin/users/${userId}/gift-subscription`, 'DELETE', { reason, cancelAtPeriodEnd });
}

export function suspendUser(userId: string, reason: string) {
  return mutate<ActionResult>(`/api/admin/users/${userId}/suspend`, 'POST', { reason });
}

export function unsuspendUser(userId: string, reason?: string) {
  return mutate<ActionResult>(`/api/admin/users/${userId}/suspend`, 'DELETE', reason ? { reason } : {});
}

export function revokeAllSessions(userId: string, reason?: string) {
  return mutate<ActionResult>(`/api/admin/users/${userId}/sessions`, 'DELETE', reason ? { reason } : {});
}

export function changeUserRole(userId: string, role: 'user' | 'admin', reason: string) {
  return mutate<ActionResult>(`/api/admin/users/${userId}/role`, 'PATCH', { role, reason });
}

export function eraseUserData(userId: string, reason: string) {
  return mutate<ActionResult>(`/api/admin/users/${userId}/data`, 'DELETE', { reason });
}

/** GDPR Article 15/20 export — downloads the JSON as a file. */
export async function downloadUserExport(userId: string): Promise<void> {
  const res = await fetchWithAuth(`/api/admin/users/${userId}/export`);
  if (!res.ok) {
    const data = await res.json().catch(() => null) as { error?: string } | null;
    throw new Error(data?.error ?? `Export failed (${res.status})`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `user-${userId}-gdpr-export.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
