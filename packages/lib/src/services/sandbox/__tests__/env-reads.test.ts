import { describe, it, expect, afterEach } from 'vitest';
import { isCodeExecutionEnabled } from '../can-run-code';
import { getSandboxSessionSecret } from '../session-manager';
import { resolveSpritesToken } from '../sandbox-client/sprites';

/**
 * These three reads run in BOTH the web app and the realtime service (the
 * terminal PTY path). They MUST read process.env directly rather than through
 * getValidatedEnv(): realtime's lean env does not satisfy the full web schema, so
 * a validated read would THROW there and (for the kill switch) deny every
 * terminal with `kill_switch_off` even when the flag is on. This suite locks that
 * decoupling — it deletes the unrelated web-only vars to prove these reads do not
 * depend on a fully-valid environment.
 */
describe('cross-service sandbox env reads', () => {
  const KEYS = ['CODE_EXECUTION_ENABLED', 'SPRITES_API_TOKEN', 'SANDBOX_SESSION_SECRET'];
  const saved = new Map<string, string | undefined>();
  for (const k of KEYS) saved.set(k, process.env[k]);

  afterEach(() => {
    for (const k of KEYS) {
      const v = saved.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('isCodeExecutionEnabled is true ONLY for the literal "true", without validating the rest of the env', () => {
    // No DATABASE_URL/CSRF_SECRET/etc. required here — a validated read would throw.
    process.env.CODE_EXECUTION_ENABLED = 'true';
    expect(isCodeExecutionEnabled()).toBe(true);

    process.env.CODE_EXECUTION_ENABLED = '1';
    expect(isCodeExecutionEnabled()).toBe(false);

    delete process.env.CODE_EXECUTION_ENABLED;
    expect(isCodeExecutionEnabled()).toBe(false);
  });

  it('resolveSpritesToken returns the token or "" when unset', () => {
    process.env.SPRITES_API_TOKEN = 'tok_123';
    expect(resolveSpritesToken()).toBe('tok_123');
    delete process.env.SPRITES_API_TOKEN;
    expect(resolveSpritesToken()).toBe('');
  });

  it('getSandboxSessionSecret returns the secret or "" when unset', () => {
    process.env.SANDBOX_SESSION_SECRET = 's'.repeat(32);
    expect(getSandboxSessionSecret()).toBe('s'.repeat(32));
    delete process.env.SANDBOX_SESSION_SECRET;
    expect(getSandboxSessionSecret()).toBe('');
  });
});
