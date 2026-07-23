/**
 * Storage attribution key (issue #2204 phase 3) — the ONE place that answers
 * "whose bill does this Sprite's persistent filesystem land on?".
 *
 * A node's tree position decides where its measurement is PERSISTED, never who
 * pays for it:
 *   • the MEASUREMENT SUBJECT is the Sprite itself — a Machine's own Sprite
 *     records bytes on its `machine_sessions` row, a branch-terminal's separate
 *     Sprite on its `machine_branches` row (writing a branch's footprint onto
 *     the machine's row would silently corrupt the machine's own figure);
 *   • the ATTRIBUTION KEY is ALWAYS the owning Machine page id. That is already
 *     the payer key (`lookupPageOwnerId(machineId)`) and the runtime-guardrail
 *     key for every branch-scoped run (`services/sandbox/branch-session.ts`),
 *     and it is the single field the per-machine usage breakdown groups on
 *     (`apps/web/src/lib/subscription/usage-breakdown.ts`'s `byMachine`). So a
 *     branch Sprite's storage shows up under its owning Terminal/Machine, not
 *     as an unattributed line the user cannot connect to anything they see.
 *
 * HONOURED BY PHASE 7 exactly as frozen: a promoted project's Sprite is the
 * third subject kind, its measurement persists on its own `machine_projects`
 * row, and its attribution key is the SAME `machinePageId`. Nothing about who
 * pays, how the breakdown groups, or the never-wake rule changed with
 * promotion: a repo that was a checkout on the machine Sprite (billed via the
 * machine's own row) and the same repo after promotion (billed via its project
 * row) charge the identical machine page.
 */

/**
 * A billable persistent filesystem. `kind` selects the row the measurement is
 * persisted on; every variant carries — directly or as `machinePageId` — the
 * owning Machine page that pays.
 */
export type StorageSubject =
  /** A Machine's own persistent Sprite; its `machine_sessions` row IS the page's. */
  | { kind: 'machine'; pageId: string }
  /** A branch-terminal's separate Sprite (`machine_branches` row), owned by `machinePageId`. */
  | { kind: 'branch'; machineBranchId: string; machinePageId: string }
  /** A PROMOTED project's separate Sprite (`machine_projects` row), owned by `machinePageId` (issue #2204 phase 7). */
  | { kind: 'project'; machineProjectId: string; machinePageId: string };

/**
 * The page id every charge, payer lookup and usage-breakdown grouping for this
 * subject keys on — the owning Machine page, whatever the subject's kind. The
 * single site that encodes "branch (and, from phase 7, project) storage bills
 * to its Machine"; callers must never re-derive it.
 */
export function storageAttributionPageId(subject: StorageSubject): string {
  return subject.kind === 'machine' ? subject.pageId : subject.machinePageId;
}

/**
 * Stable string key for a subject, for in-process bookkeeping (measurement
 * throttle / in-flight dedup) that needs a Map key rather than an object.
 * Namespaced by kind so a branch or project row id can never collide with a
 * page id — or with each other.
 */
export function storageSubjectKey(subject: StorageSubject): string {
  switch (subject.kind) {
    case 'machine':
      return `machine:${subject.pageId}`;
    case 'branch':
      return `branch:${subject.machineBranchId}`;
    case 'project':
      return `project:${subject.machineProjectId}`;
  }
}
