/**
 * The LEGACY layout endpoints' response bodies — the two-level `columns[].panes[]`
 * model, kept alive for the migration window.
 *
 * **The runtime SCHEMAS that used to live here are gone with their only
 * consumer.** They were the browser's parse of these responses, and the browser
 * no longer speaks this wire at all: the store reads `{rev, nodes, targets}`
 * from the node endpoint. What survives is the TYPES, which the verb route and
 * its runtime still use to describe what they write. A zod schema nothing parses
 * with is not a contract, it is a second description of one — the exact
 * duplication this module was created to remove, arriving from the other side.
 *
 * It lives in `packages/lib` rather than beside the route because a client
 * cannot import the runtime module — that one pulls in `@pagespace/db`.
 */

import type { PersistedColumnState } from './contract';

/*
 * Written out rather than `z.infer`ed, from when the schemas were still here:
 * `persistedColumnStateSchema` carries a `.transform()`, and inferring through
 * it across the package's emitted `.d.ts` degraded to `any` at the consumer —
 * worse than duplication, because it failed silently. Referencing
 * `PersistedColumnState` directly keeps the declaration stable across the build,
 * and is now simply how these are declared.
 */
export interface WorkspaceLayoutSnapshot {
  rev: number;
  /** `null` when the workspace has no pane rows at all — not the same as `[]`. */
  grid: PersistedColumnState[] | null;
}

export interface WorkspaceLayoutVerbResponse {
  rev: number;
  grid: PersistedColumnState[];
  /** The persistence layer's content diff: did this verb change anything. */
  applied: boolean;
}

export interface WorkspaceLayoutStaleResponse {
  rev: number;
  grid: PersistedColumnState[];
}
