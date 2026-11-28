import { uiSlices } from './slices';
import type { UiState } from './state';
import type { UnionToIntersection } from './types';
import { getUiState, setUiState } from './store';

/** A pure transaction: the next snapshot from the current one and an argument. */
export type UiTransaction<A> = (state: UiState, arg: A) => UiState;

/** A section plugin: the transactions that section owns. */
export type UiPlugin = {
  // `never` accepts every argument type: each plugin keeps its own.
  readonly transactions: Readonly<Record<string, UiTransaction<never>>>;
};

type MergedTransactions<P extends readonly UiPlugin[]> = [P[number]] extends [never]
  ? Readonly<Record<never, never>>
  : UnionToIntersection<P[number]['transactions']>;

/** Merges plugin transactions into one namespace; a name may be defined once. */
export const mergePlugins = <const P extends readonly UiPlugin[]>(
  ...plugins: P
): MergedTransactions<P> => {
  const merged: Record<string, UiTransaction<never>> = {};
  for (const plugin of plugins) {
    for (const [name, transaction] of Object.entries(plugin.transactions)) {
      if (name in merged) throw new Error(`Duplicate UI transaction: ${name}`);
      merged[name] = transaction;
    }
  }
  return merged as MergedTransactions<P>;
};

/** The shell's transactions, merged from the registered slices (slices.ts). */
export const transactions = mergePlugins(...uiSlices);

/** Runs a transaction over the current snapshot and stores the result. */
export const dispatch = <A>(run: UiTransaction<A>, arg: A): void => {
  setUiState(run(getUiState(), arg));
};
