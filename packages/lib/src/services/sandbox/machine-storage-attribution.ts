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
 *
 * PHASE 7 ADDS a fifth subject kind, `agent-session` — the `agent_sessions`
 * twin of the four machine-tree kinds above, added ALONGSIDE them (the old
 * machine-tree kinds keep metering unchanged until the Phase 8 teardown; see
 * `machine-storage-reconcile.ts`'s module doc). It breaks the "attribution key
 * is always a page" assumption the other four kinds share: an `agent_sessions`
 * row's `agentPageId` is nullable (null = a global-assistant session with no
 * backing page at all), so there is no page to group a global session's usage
 * under. `storageBillingTarget` below is the one place that branches on this;
 * `storageAttributionPageId` itself is intentionally left total only over the
 * four page-shaped kinds (see its narrowed parameter type).
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
  | { kind: 'project'; machineProjectId: string; machinePageId: string }
  /** A per-session agent-terminal's separate Sprite (`machine_agent_terminals` row), owned by `machinePageId` (sessions-per-location). */
  | { kind: 'agent-terminal'; machineAgentTerminalId: string; machinePageId: string }
  /**
   * An `agent_sessions` row's own Sprite (Phase 7, ADDED alongside the four
   * kinds above — see module doc). `agentPageId` is nullable (a
   * global-assistant session); `ownerId` is the session's own owner and is
   * ALWAYS present, so it is carried directly rather than requiring a second
   * lookup the way the other kinds' `machinePageId` does.
   */
  | { kind: 'agent-session'; sessionId: string; agentPageId: string | null; ownerId: string };

/** The four legacy machine-tree subject kinds — every kind that is unconditionally page-shaped. Also the domain of opportunistic measurement (`machine-storage-measure.ts`), which Phase 7 does not extend to agent-sessions. */
export type PageAttributedStorageSubject = Exclude<StorageSubject, { kind: 'agent-session' }>;

/**
 * The page id every charge, payer lookup and usage-breakdown grouping for a
 * LEGACY machine-tree subject keys on — the owning Machine page, whatever the
 * subject's kind. The single site that encodes "branch (and, from phase 7,
 * project) storage bills to its Machine"; callers must never re-derive it.
 *
 * Deliberately NOT total over `StorageSubject`: an `agent-session` subject may
 * have no page at all (a global-assistant session), so it is excluded from
 * this function's domain by its parameter type rather than by a runtime
 * branch. Use `storageBillingTarget` for a subject that may be either.
 */
export function storageAttributionPageId(subject: PageAttributedStorageSubject): string {
  return subject.kind === 'machine' ? subject.pageId : subject.machinePageId;
}

/**
 * Who ultimately gets billed for a subject's storage, and — separately —
 * what pageId (if any) the usage-breakdown groups it under. For the four
 * legacy machine-tree kinds these are the same page id, resolved via
 * `storageAttributionPageId`; a global-assistant `agent-session` (null
 * `agentPageId`) has no page to attribute to, so billing falls straight
 * through to its `ownerId` with no page lookup at all — the ONE place this
 * fork exists (mirrors `resolveAgentSessionPayerId` in `billing/machine-payer`,
 * which the storage reconcile's IO composition uses for the `ownerId` case).
 */
export function storageBillingTarget(subject: StorageSubject): { pageId: string } | { ownerId: string } {
  if (subject.kind === 'agent-session') {
    return subject.agentPageId ? { pageId: subject.agentPageId } : { ownerId: subject.ownerId };
  }
  return { pageId: storageAttributionPageId(subject) };
}

/**
 * Stable string key for a subject, for in-process bookkeeping (measurement
 * throttle / in-flight dedup) that needs a Map key rather than an object.
 * Namespaced by kind so a branch, project or session row id can never collide
 * with a page id — or with each other.
 */
export function storageSubjectKey(subject: StorageSubject): string {
  switch (subject.kind) {
    case 'machine':
      return `machine:${subject.pageId}`;
    case 'branch':
      return `branch:${subject.machineBranchId}`;
    case 'project':
      return `project:${subject.machineProjectId}`;
    case 'agent-terminal':
      return `agent-terminal:${subject.machineAgentTerminalId}`;
    case 'agent-session':
      return `agent-session:${subject.sessionId}`;
  }
}
