import { format, isSameDay, subDays } from 'date-fns';
import type { ActivityActionPreview } from '@/retained/types/activity-actions';

/** One row of GET /api/pages/[pageId]/history `versions` (ActivityLogForRollback + canRollback). */
export interface HistoryVersion {
  id: string;
  timestamp: string;
  userId: string | null;
  actorEmail: string;
  actorDisplayName: string | null;
  operation: string;
  resourceTitle: string | null;
  isAiGenerated: boolean;
  aiProvider: string | null;
  changeGroupType: 'user' | 'ai' | 'automation' | 'system' | null;
  updatedFields: string[] | null;
  rollbackFromActivityId: string | null;
  canRollback: boolean;
}

export type HistoryFilter = 'all' | 'ai';

export interface HistoryGroup {
  label: string;
  items: HistoryVersion[];
}

const operationVerbs: Record<string, string> = {
  create: 'created',
  created: 'created',
  update: 'updated',
  updated: 'updated',
  'content-updated': 'updated',
  delete: 'deleted',
  deleted: 'deleted',
  trash: 'trashed',
  trashed: 'trashed',
  restore: 'restored',
  restored: 'restored',
  move: 'moved',
  moved: 'moved',
  reorder: 'reordered',
  rollback: 'rolled back',
  permission_grant: 'shared',
  permission_update: 'changed sharing of',
  permission_revoke: 'revoked access to',
};

/** "updated the page" style verb phrase for a row. */
export function verbOf(version: HistoryVersion): string {
  return `${operationVerbs[version.operation] ?? version.operation.replace(/[_-]/g, ' ')} the page`;
}

/** Who did it: the live name, then the denormalized actor, then the AI tile's name. */
export function actorOf(version: HistoryVersion): string {
  return version.actorDisplayName || version.actorEmail || (version.isAiGenerated ? 'Imago' : 'Unknown');
}

export function initialOf(version: HistoryVersion): string {
  return actorOf(version).charAt(0).toUpperCase();
}

/** The short line under the actor: which fields changed, else what was touched. */
export function summaryOf(version: HistoryVersion): string {
  if (version.updatedFields && version.updatedFields.length > 0) {
    return `Changed ${version.updatedFields.join(', ')}`;
  }
  return version.resourceTitle ?? 'Page activity';
}

/** The AI badge's "via": automation runs are labelled as such, everything else was asked for. */
export function aiViaOf(version: HistoryVersion): 'automation' | 'asked by you' {
  return version.changeGroupType === 'automation' ? 'automation' : 'asked by you';
}

/** Ids of activities that a later rollback reverted (rollbackFromActivityId points back at them). */
export function rolledBackIds(versions: readonly HistoryVersion[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const version of versions) {
    if (version.rollbackFromActivityId) ids.add(version.rollbackFromActivityId);
  }
  return ids;
}

/** Case-insensitive match over the text a row shows. An empty query keeps everything. */
export function filterVersions(versions: readonly HistoryVersion[], query: string): HistoryVersion[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...versions];
  return versions.filter((version) =>
    [actorOf(version), verbOf(version), summaryOf(version), version.resourceTitle ?? '']
      .some((text) => text.toLowerCase().includes(needle)),
  );
}

function dayLabel(date: Date, now: Date): string {
  if (isSameDay(date, now)) return 'Today';
  if (isSameDay(date, subDays(now, 1))) return 'Yesterday';
  return format(date, 'MMM d');
}

/** Rows in their received (newest first) order, split into Today / Yesterday / date groups. */
export function groupVersions(versions: readonly HistoryVersion[], now: Date): HistoryGroup[] {
  const groups: HistoryGroup[] = [];
  for (const version of versions) {
    const label = dayLabel(new Date(version.timestamp), now);
    const existing = groups.find((group) => group.label === label);
    if (existing) {
      existing.items.push(version);
    } else {
      groups.push({ label, items: [version] });
    }
  }
  return groups;
}

/** Time under a row: the clock on today's rows, weekday and clock on older ones. */
export function timeLabelOf(version: HistoryVersion, now: Date): string {
  const date = new Date(version.timestamp);
  return isSameDay(date, now) ? format(date, 'h:mm a') : format(date, 'EEE h:mm a');
}

/** The retention meta. The API reports -1 for unlimited retention. */
export function retentionLabelOf(retentionDays: number): string {
  return retentionDays < 0 ? 'Unlimited history' : `Last ${retentionDays} days`;
}

/** Undo is offered only when the preview says it can run (forced when the preview requires it). */
export function canUndoNow(preview: ActivityActionPreview | null, force: boolean): boolean {
  return preview !== null && !preview.isNoOp && (preview.canExecute || (preview.requiresForce && force));
}

/** How many activities a rollback to this point would actually revert under the current force choice. */
export function rollbackToPointCount(
  affected: readonly { readonly preview: ActivityActionPreview }[],
  force: boolean,
): number {
  return affected.filter((item) => item.preview.canExecute || (force && item.preview.requiresForce)).length;
}
