/**
 * The credit gate asked for an account that has no `users` row. Every gate
 * caller authenticated a user, so this "cannot happen" — which is exactly why it
 * must fail CLOSED (Agent Signup Phase 1b): defaulting a missing row to `human`
 * would hand a deleted or never-created principal the human starter grant and
 * the billing-off unlimited path. `canConsumeAI` maps it to a refusal and
 * `hasSpendableBalance` to `false`.
 *
 * Its own module so the gate's unit tests, which stub `gate-account` wholesale,
 * still share the one class identity.
 */
export class GateAccountNotFoundError extends Error {
  readonly userId: string;

  constructor(userId: string) {
    super(`No users row for credit-gate account ${userId}`);
    this.name = 'GateAccountNotFoundError';
    this.userId = userId;
  }
}
