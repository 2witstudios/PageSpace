/**
 * Org sign-in policy for drive backups (SEC-2/3, D-OW-62). A backup snapshots every page of a drive, and its export and
 * previews serve that content back, so each is a read like any other: a page restating org-derived content (a memory
 * page) that a contributing org's sign-in policy withholds from the credential is left out, and the backup or export
 * says what was left out and the code that unlocks it, so the person can sign in again (or with a passkey) and retry.
 *
 * The drive itself is already gated by the owner/admin check (isDriveOwnerOrAdmin asks the drive's own sign-in policy);
 * what remains is per page. An automation (a scheduled backup) is judged by its scope, so it snapshots everything; the
 * credential that later exports or previews it is gated then.
 */
import { refusedDerivedPages } from '@pagespace/lib/permissions/org-derived-content';
import type { AccessActor, OrgAuthenticationDenialCode } from '@pagespace/lib/permissions/access-actor';

export type BackupWithheldCategory = 'memoryPages';

export interface BackupWithheld {
  category: BackupWithheldCategory;
  count: number;
  code: OrgAuthenticationDenialCode;
  orgIds: string[];
}

/** What a snapshot left out, kept on the backup record's metadata so its export, previews and restore honour it. */
export interface SnapshotWithheld {
  pageIds: string[];
  entries: BackupWithheld[];
}

export const BACKUP_WITHHELD_METADATA_KEY = 'signInWithheld';

const isDenialCode = (value: unknown): value is OrgAuthenticationDenialCode =>
  value === 'org_strong_sign_in_required' || value === 'org_reauthentication_required';

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

/** The pages of `pageIds` this credential may not read from a backup, and the manifest entries naming them. */
export async function withheldBackupPages(
  actor: AccessActor,
  pageIds: readonly string[],
): Promise<{ pageIds: Set<string>; entries: BackupWithheld[] }> {
  const refused = await refusedDerivedPages(actor, pageIds);
  const byCode = new Map<OrgAuthenticationDenialCode, BackupWithheld>();
  for (const refusal of refused.values()) {
    const entry = byCode.get(refusal.code) ?? { category: 'memoryPages', count: 0, code: refusal.code, orgIds: [] };
    byCode.set(refusal.code, {
      ...entry,
      count: entry.count + 1,
      orgIds: [...new Set([...entry.orgIds, ...refusal.orgIds])].sort(),
    });
  }
  return { pageIds: new Set(refused.keys()), entries: [...byCode.values()] };
}

/** What the snapshot left out, read back from the backup's metadata (nothing when absent or malformed). */
export function readSnapshotWithheld(metadata: Record<string, unknown> | null | undefined): SnapshotWithheld {
  const raw = metadata?.[BACKUP_WITHHELD_METADATA_KEY];
  if (typeof raw !== 'object' || raw === null) return { pageIds: [], entries: [] };
  const record = raw as Record<string, unknown>;
  const pageIds = isStringArray(record.pageIds) ? record.pageIds : [];
  const entries = Array.isArray(record.entries)
    ? record.entries.flatMap((item): BackupWithheld[] => {
        if (typeof item !== 'object' || item === null) return [];
        const e = item as Record<string, unknown>;
        if (e.category !== 'memoryPages' || typeof e.count !== 'number' || !isDenialCode(e.code) || !isStringArray(e.orgIds)) return [];
        return [{ category: 'memoryPages', count: e.count, code: e.code, orgIds: e.orgIds }];
      })
    : [];
  return { pageIds, entries };
}

/** One entry per category and code: counts summed, refusing orgs united and sorted. */
export function mergeWithheld(...lists: ReadonlyArray<readonly BackupWithheld[]>): BackupWithheld[] {
  const merged = new Map<string, BackupWithheld>();
  for (const entry of lists.flat()) {
    const key = `${entry.category}:${entry.code}`;
    const prior = merged.get(key);
    merged.set(key, prior
      ? { ...prior, count: prior.count + entry.count, orgIds: [...new Set([...prior.orgIds, ...entry.orgIds])].sort() }
      : { ...entry, orgIds: [...entry.orgIds].sort() });
  }
  return [...merged.values()];
}

/**
 * The rows of a backup a credential may read now: drops the pages the snapshot withheld (they are not in it) and the
 * pages withheld from THIS credential (a backup another credential, or a scheduled run, took), and names both.
 */
export async function gateBackupRows<Row extends { pageId: string }>(
  actor: AccessActor,
  backupMetadata: Record<string, unknown> | null | undefined,
  rows: readonly Row[],
): Promise<{ rows: Row[]; withheld: BackupWithheld[] }> {
  const atSnapshot = readSnapshotWithheld(backupMetadata);
  const now = await withheldBackupPages(actor, rows.map((row) => row.pageId));
  return {
    rows: rows.filter((row) => !now.pageIds.has(row.pageId)),
    withheld: mergeWithheld(atSnapshot.entries, now.entries),
  };
}
