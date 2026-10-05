/**
 * The create dialog's setup plan (drives to move, people to invite), kept in this browser until it runs, so a
 * checkout abandoned before the org is paid loses nothing: the hub offers "Finish setup" once the org is
 * active (review P2-7). Per-browser by design; every read and write survives blocked storage.
 */
export interface PendingOrgSetup {
  driveIds: string[];
  invites: string[];
  selfEmail: string;
  driveNames: Record<string, string>;
}

const key = (orgId: string) => `pagespace.orgSetup.${orgId}`;

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

export function savePendingSetup(orgId: string, plan: PendingOrgSetup): void {
  try {
    if (plan.driveIds.length === 0 && plan.invites.length === 0) localStorage.removeItem(key(orgId));
    else localStorage.setItem(key(orgId), JSON.stringify(plan));
  } catch {
    // storage blocked: the dialog still tells the person what was not done
  }
}

export function loadPendingSetup(orgId: string): PendingOrgSetup | null {
  try {
    const raw = localStorage.getItem(key(orgId));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<PendingOrgSetup>;
    if (!isStrings(v.driveIds) || !isStrings(v.invites) || typeof v.selfEmail !== 'string') return null;
    const names = v.driveNames && typeof v.driveNames === 'object' ? (v.driveNames as Record<string, string>) : {};
    return { driveIds: v.driveIds, invites: v.invites, selfEmail: v.selfEmail, driveNames: names };
  } catch {
    return null;
  }
}

export function clearPendingSetup(orgId: string): void {
  try {
    localStorage.removeItem(key(orgId));
  } catch {
    // nothing to clear
  }
}
