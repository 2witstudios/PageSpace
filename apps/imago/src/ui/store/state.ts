import { uiSlices } from './slices';
import type { UiPlugin } from './transactions';
import type { UnionToIntersection } from './types';

/**
 * A section's store slice: its transactions plus the scalar resources it
 * owns (drafts, filters, expansion), built fresh for every initial state.
 */
export type UiSlice = UiPlugin & {
  readonly resources: () => Readonly<Record<string, unknown>>;
};

type MergedResources<S extends readonly UiSlice[]> = [S[number]] extends [never]
  ? Readonly<Record<never, never>>
  : UnionToIntersection<ReturnType<S[number]['resources']>>;

/** Merges slice resources into one record factory; a key may be owned once. */
export const composeResources = <const S extends readonly UiSlice[]>(
  ...slices: S
): (() => MergedResources<S>) => {
  const owned = new Set<string>();
  for (const slice of slices) {
    for (const key of Object.keys(slice.resources())) {
      if (owned.has(key)) throw new Error(`Duplicate UI resource: ${key}`);
      owned.add(key);
    }
  }
  return () => Object.assign({}, ...slices.map((slice) => slice.resources())) as MergedResources<S>;
};

const initialResources = composeResources(...uiSlices);

/**
 * Scalar shell state (drafts, filters, expansion, the open conversation),
 * composed from the registered slices.
 */
export type UiResources = ReturnType<typeof initialResources>;

/**
 * Entity lists the shell renders (files, conversations, tasks). Real data
 * from later leaves fills these; there is no mock seed.
 */
export type UiCollections = Readonly<Record<never, never>>;

export type UiState = {
  readonly resources: UiResources;
  readonly collections: UiCollections;
};

/** The empty shell: the swap point for real data from later leaves. */
export const createInitialState = (): UiState => ({
  resources: initialResources(),
  collections: {},
});
