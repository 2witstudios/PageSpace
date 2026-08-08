/**
 * The layout endpoints' RESPONSE bodies — declared once, for the route that
 * writes them and the store that parses them.
 *
 * Both sides used to declare their own. `WorkspaceLayoutSnapshot` existed
 * twice under the same name (`workspace-layout-runtime.ts` and
 * `useAgentWorkspaceStore.ts`), structurally equal and related by nothing, and
 * the store's verb-response schema silently dropped the `applied` field the
 * route actually returns. Two declarations of one wire is exactly the drift the
 * rest of this epic spent its time removing.
 *
 * It lives in `packages/lib` rather than beside the route because the client
 * cannot import the runtime module — that one pulls in `@pagespace/db`.
 */

import { z } from 'zod';
import { persistedColumnStateSchema, type PersistedColumnState } from './contract';

/** A grid as it crosses the wire: columns in order, each with its panes. */
export const workspaceLayoutGridSchema = z.array(persistedColumnStateSchema);

/**
 * `GET /workspace` — the whole truth for one workspace.
 * `grid: null` means the workspace has no pane rows at all, which is different
 * from an empty array and is why the field is nullable rather than defaulted.
 */
export const workspaceLayoutSnapshotSchema = z.object({
  rev: z.number().int().min(0),
  grid: workspaceLayoutGridSchema.nullable(),
});

/**
 * A verb POST's 200 body.
 *
 * `applied` is the store's authority on whether anything actually changed —
 * the reducer's structural verdict only says the target resolved, while this
 * comes from the persistence layer's content diff. It was being parsed away.
 */
export const workspaceLayoutVerbResponseSchema = z.object({
  rev: z.number().int().min(0),
  grid: workspaceLayoutGridSchema,
  applied: z.boolean(),
});

/**
 * A verb POST's 409 body: the current truth to rebase against. No `applied` —
 * nothing was applied, which is the whole point of the status code.
 */
export const workspaceLayoutStaleResponseSchema = z.object({
  rev: z.number().int().min(0),
  grid: workspaceLayoutGridSchema,
});

/*
 * Written out rather than `z.infer`ed. `persistedColumnStateSchema` carries a
 * `.transform()`, and inferring through it across the package's emitted `.d.ts`
 * degrades to `any` at the consumer — which is worse than the duplication this
 * module exists to remove, because it fails silently. Referencing
 * `PersistedColumnState` directly keeps the declaration stable across the
 * build.
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
