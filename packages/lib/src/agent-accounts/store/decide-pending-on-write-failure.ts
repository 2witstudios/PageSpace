/**
 * `decidePendingOnWriteFailure` — what a failed replacing write does to the
 * pending marker it set (G2 ruling E1(a)).
 *
 * A failure the adapter KNOWS preceded sending (`not_sent`: the Universal Auth
 * login failed, the request could not be built) cannot have changed
 * Infisical, so the marker is aborted in the same locked section and the ref
 * stays in service. Any other failure — a network error or timeout after the
 * request left, any answer from Infisical — leaves the outcome unknown: the
 * marker is kept and the next locked call reconciles by observing Infisical
 * (`decideReconcile`). Pure.
 */
import type { DecidePendingOnWriteFailure } from './store-adapter';

export const decidePendingOnWriteFailure: DecidePendingOnWriteFailure = ({ failure }) =>
  failure === 'not_sent' ? { action: 'abort_pending' } : { action: 'keep_pending' };
