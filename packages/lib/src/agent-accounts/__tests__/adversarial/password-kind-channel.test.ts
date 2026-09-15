import { describe, it } from 'vitest';

// Threat model C3, D-20 (Λ3). password is resolvable only by the browser-fill executor.

describe('adversarial: password-kind-channel', () => {
  it.todo('given kind password requested by http-executor, should be unrepresentable by type (@ts-expect-error) and kind_not_resolvable at the adapter');
  it.todo('given kind password requested by relay-runner or refresh-worker, should return kind_not_resolvable');
  it.todo('given kind password requested by browser-worker under a verified grant, should resolve');
  it.todo('given the kind_not_resolvable rule broken by line index (mutation), should go RED; restored, GREEN');
});
