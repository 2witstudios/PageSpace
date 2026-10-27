import { format } from 'date-fns';

/** The real counts a drive delete touches, read from the drive's own routes. */
export type DeleteCounts = {
  readonly pages: number;
  readonly people: number;
  readonly guests: number;
  readonly agents: number;
  readonly apps: number;
};

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** The three consequence lines of "Deleting this drive will:", with the real counts. */
export const deleteConsequences = (counts: DeleteCounts): readonly string[] => [
  `Move all ${plural(counts.pages, 'page', 'pages')} and their content to trash`,
  `Revoke access for ${plural(counts.people, 'person', 'people')}, ${plural(counts.guests, 'guest', 'guests')}, ${plural(counts.agents, 'agent', 'agents')} and ${plural(counts.apps, 'app', 'apps')}`,
  'Stop all AI agents and automations',
];

/** The delete button stays disabled until the typed text is the drive's exact name. */
export const isExactNameConfirmed = (driveName: string, typed: string): boolean =>
  driveName.length > 0 && typed === driveName;

/** Counts the pages in a drive's page tree (the pages route returns nested nodes with `children`). */
export const countTreePages = (nodes: unknown): number => {
  if (!Array.isArray(nodes)) return 0;
  return nodes.reduce<number>((total, node) => {
    if (typeof node !== 'object' || node === null) return total;
    const children: unknown = 'children' in node ? node.children : undefined;
    return total + 1 + countTreePages(children);
  }, 0);
};

/** The latest finished backup's completion time, or null when no backup has finished. */
export const latestFinishedBackupAt = (backups: readonly { readonly status: string; readonly completedAt: string | null }[]): string | null => {
  let latest: number | null = null;
  for (const backup of backups) {
    if (backup.status !== 'ready' || backup.completedAt === null) continue;
    const time = new Date(backup.completedAt).getTime();
    if (Number.isNaN(time)) continue;
    if (latest === null || time > latest) latest = time;
  }
  return latest === null ? null : new Date(latest).toISOString();
};

/** The safety-net line under the delete form, split around its link to Backups. */
export const safetyNetParts = (lastBackupAt: string | null): { readonly lead: string; readonly linkText: string; readonly tail: string } => ({
  lead: 'Want a safety net first? ',
  linkText: 'Create a backup',
  tail: lastBackupAt === null ? '.' : ` — the last one finished ${format(new Date(lastBackupAt), 'MMM d')}.`,
});
