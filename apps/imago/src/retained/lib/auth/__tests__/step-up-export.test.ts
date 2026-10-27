import { expect, test } from 'vitest';
import * as ceremony from '../step-up-ceremony';
test('the strong org sign-in flow can invoke the passkey-only ceremony', () => {
  expect('runWebauthnStepUp' in ceremony && typeof ceremony.runWebauthnStepUp).toBe('function');
});
