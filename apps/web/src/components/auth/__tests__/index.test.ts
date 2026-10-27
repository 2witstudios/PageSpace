import { describe, it, expect } from 'vitest';
import * as authComponents from '../index';

describe('auth component exports', () => {
  it('[Unit]_AuthComponents_DoesNotExportUseConditionalPasskeyUI', () => {
    const actual = Object.prototype.hasOwnProperty.call(
      authComponents,
      'useConditionalPasskeyUI',
    );
    const given = 'the auth components index';
    const should =
      'not export useConditionalPasskeyUI — the conditional-UI wiring is dead code and has been removed';
    const expected = false;
    expect(actual, `${given} ${should}`).toBe(expected);
  });

  it('[Unit]_AuthComponents_ExportsPasskeyLoginButton', () => {
    const actual = Object.prototype.hasOwnProperty.call(
      authComponents,
      'PasskeyLoginButton',
    );
    const given = 'the auth components index';
    const should =
      'still export PasskeyLoginButton — it is the single passkey entry point';
    const expected = true;
    expect(actual, `${given} ${should}`).toBe(expected);
  });
});
