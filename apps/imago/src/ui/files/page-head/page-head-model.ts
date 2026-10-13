import type { PageTypeValue } from '@pagespace/lib/utils/enums';

export type Crumb = { readonly id: string; readonly label: string; readonly current: boolean };

/**
 * The page head's path (SPEC v3.3: "Launch › Q4 Launch Plan", the last step the page). The
 * trail must end at this page, so a stale one never names the wrong place.
 */
export const crumbsOf = (
  trail: readonly { readonly id: string; readonly title: string }[] | undefined,
  pageId: string,
  type: PageTypeValue | null,
): readonly Crumb[] => {
  if (trail === undefined || trail.at(-1)?.id !== pageId) return [];
  return trail.map((step, index) => {
    const current = index === trail.length - 1;
    return { id: step.id, label: current && type === 'CHANNEL' ? `#${step.title}` : step.title, current };
  });
};

/** Presence avatars appear only on pages people edit together (SPEC v3). */
export const isCollaborative = (type: string): boolean =>
  ['DOCUMENT', 'SHEET', 'CODE', 'CANVAS', 'TASK_LIST', 'CHANNEL'].includes(type);
