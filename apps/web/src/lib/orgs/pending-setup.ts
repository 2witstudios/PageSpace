import { removeKeysWithPrefixes } from '@/lib/auth/clear-user-stores';
import { ORG_SETUP_STORAGE_PREFIX as PREFIX } from '@/lib/auth/clear-user-stores-core';

/**
 * The create dialog's setup plan (drives to move, people to invite), kept in this browser until it runs, so a
 * checkout abandoned before the org is paid loses nothing: the hub offers "Finish setup" once the org is
 * active (review P2-7). Keyed by person and org, so another account on the same browser never sees it, and
 * purged on sign-out and on an account switch (review N1). It holds no secrets: drive ids and names, the
 * invitee addresses and the creator's own address, nothing from billing. Every read and write survives
 * blocked storage.
 */
export interface PendingOrgSetup {
  driveIds: string[];
  invites: string[];
  selfEmail: string;
  driveNames: Record<string, string>;
}

const key = (userId: string, orgId: string) => `${PREFIX}${userId}.${orgId}`;

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

export function savePendingSetup(userId: string, orgId: string, plan: PendingOrgSetup): void {
  if (!userId) return;
  try {
    if (plan.driveIds.length === 0 && plan.invites.length === 0) localStorage.removeItem(key(userId, orgId));
    else {
      const { driveIds, invites, selfEmail, driveNames } = plan;
      localStorage.setItem(key(userId, orgId), JSON.stringify({ driveIds, invites, selfEmail, driveNames }));
    }
  } catch {
    // storage blocked: the dialog still tells the person what was not done
  }
}

export function loadPendingSetup(userId: string, orgId: string): PendingOrgSetup | null {
  if (!userId) return null;
  try {
    const raw = localStorage.getItem(key(userId, orgId));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<PendingOrgSetup>;
    if (!isStrings(v.driveIds) || !isStrings(v.invites) || typeof v.selfEmail !== 'string') return null;
    const names = v.driveNames && typeof v.driveNames === 'object' ? (v.driveNames as Record<string, string>) : {};
    return { driveIds: v.driveIds, invites: v.invites, selfEmail: v.selfEmail, driveNames: names };
  } catch {
    return null;
  }
}

export function clearPendingSetup(userId: string, orgId: string): void {
  try {
    localStorage.removeItem(key(userId, orgId));
  } catch {
    // nothing to clear
  }
}

/** Sign-out: drop every saved plan in this browser, whoever saved it. */
export function purgePendingSetups(): void {
  try {
    removeKeysWithPrefixes(localStorage, [PREFIX]);
  } catch {
    // nothing to clear
  }
}

