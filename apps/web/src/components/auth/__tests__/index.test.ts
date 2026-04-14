import { describe, it, expect } from 'vitest';
import * as authBarrel from '../index';

describe('auth barrel exports', () => {
  it('[Unit]_AuthBarrel_DoesNotExportUseConditionalPasskeyUI', () => {
    const actual = Object.prototype.hasOwnProperty.call(
      authBarrel,
      'useConditionalPasskeyUI',
    );
    const given = 'the auth components barrel';
    const should =
      'not export useConditionalPasskeyUI — the conditional-UI wiring is dead code and has been removed';
    const expected = false;
    expect(actual, `${given} ${should}`).toBe(expected);
  });

  it('[Unit]_AuthBarrel_ExportsPasskeyLoginButton', () => {
    const actual = Object.prototype.hasOwnProperty.call(
      authBarrel,
      'PasskeyLoginButton',
    );
    const given = 'the auth components barrel';
    const should =
      'still export PasskeyLoginButton — it is the single passkey entry point';
    const expected = true;
    expect(actual, `${given} ${should}`).toBe(expected);
  });
});
