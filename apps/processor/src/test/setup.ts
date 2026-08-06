/**
 * Vitest setup for @pagespace/processor.
 *
 * Node >= 23 removed the long-deprecated `util.isNullOrUndefined`, but
 * @tensorflow/tfjs-node 4.x (magika's backend) still calls it at classify
 * time. CI runs Node 22 so the gap only shows locally on newer Node, where
 * every magika classification throws "(0 , util_1.isNullOrUndefined) is not
 * a function" and the content-detector suites fail against a fully present
 * model. Restoring the one-line predicate before tfjs-node loads lets the
 * real model run on every Node version instead of skipping the suites.
 * Remove once tfjs-node ships a release that no longer uses the API.
 */
import util from 'util';

type UtilWithLegacyPredicate = typeof util & {
  isNullOrUndefined?: (value: unknown) => boolean;
};

const patchable = util as UtilWithLegacyPredicate;
if (typeof patchable.isNullOrUndefined !== 'function') {
  patchable.isNullOrUndefined = (value: unknown): boolean =>
    value === null || value === undefined;
}
