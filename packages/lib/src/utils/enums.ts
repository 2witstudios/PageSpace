export enum PageType {
  FOLDER = 'FOLDER',
  DOCUMENT = 'DOCUMENT',
  CHANNEL = 'CHANNEL',
  AI_CHAT = 'AI_CHAT',
  CANVAS = 'CANVAS',
  FILE = 'FILE',
  SHEET = 'SHEET',
  TASK_LIST = 'TASK_LIST',
  CODE = 'CODE',
  MACHINE = 'MACHINE',
}

/**
 * The string-literal union form of `PageType`. Prefer this over hand-written
 * unions like `'FOLDER' | 'DOCUMENT' | ...`: it is derived, so it cannot
 * drift, and unlike the enum type itself it is mutually assignable with the
 * DB's `PageTypeEnum` (`@pagespace/db/schema/core`).
 */
export type PageTypeValue = `${PageType}`;

/**
 * Every page type, as runtime values. Prefer this over hand-written arrays —
 * see #2150, where three separate re-declarations had drifted and silently
 * dropped FILE and MACHINE.
 */
export const PAGE_TYPE_VALUES: readonly PageTypeValue[] = Object.values(PageType);

export function isPageTypeValue(value: string): value is PageTypeValue {
  return (PAGE_TYPE_VALUES as readonly string[]).includes(value);
}

/**
 * Parses a comma-separated `includeTypes` query param into page types.
 *
 * Segments are trimmed; empty and unknown segments are dropped silently (the
 * route's long-standing behaviour — an unknown type is not a request error),
 * and duplicates are removed with first-seen order preserved. A missing or
 * empty param returns `undefined`, meaning "no type filter".
 *
 * Note that an all-unknown param yields `[]`, which downstream callers such
 * as `globSearchPages` also treat as "no filter".
 */
export function parsePageTypesParam(param: string | null): PageTypeValue[] | undefined {
  if (!param) return undefined;

  const seen = new Set<PageTypeValue>();
  for (const segment of param.split(',')) {
    const candidate = segment.trim();
    if (isPageTypeValue(candidate)) seen.add(candidate);
  }
  return [...seen];
}

export enum PermissionAction {
  VIEW = 'VIEW',
  EDIT = 'EDIT',
  SHARE = 'SHARE',
  DELETE = 'DELETE',
}

export enum SubjectType {
  USER = 'USER',
}