import { describe, it, expect } from 'vitest';
import { evaluateCommandPolicy, MAX_COMMAND_BYTES } from '../command-policy';

describe('evaluateCommandPolicy', () => {
  it('given a normal command, should allow it', () => {
    expect(evaluateCommandPolicy({ command: 'echo hello' })).toEqual({ ok: true });
  });

  it('given an empty command, should deny with empty_command', () => {
    expect(evaluateCommandPolicy({ command: '   ' })).toEqual({
      ok: false,
      reason: 'empty_command',
    });
  });

  it('given no input at all, should deny with empty_command rather than throw', () => {
    expect(evaluateCommandPolicy()).toEqual({ ok: false, reason: 'empty_command' });
  });

  it('given a command larger than the byte cap, should deny with command_too_large', () => {
    const command = 'a'.repeat(MAX_COMMAND_BYTES + 1);
    expect(evaluateCommandPolicy({ command })).toEqual({
      ok: false,
      reason: 'command_too_large',
    });
  });

  it('given a custom byte cap, should enforce it', () => {
    expect(evaluateCommandPolicy({ command: 'abcdef', maxBytes: 3 })).toEqual({
      ok: false,
      reason: 'command_too_large',
    });
  });

  it('given a command reaching the cloud metadata IP, should deny with blocked_metadata_access', () => {
    expect(
      evaluateCommandPolicy({ command: 'curl http://169.254.169.254/latest/meta-data/' }),
    ).toEqual({ ok: false, reason: 'blocked_metadata_access' });
  });

  it('given the metadata IP in decimal encoding, should still deny', () => {
    expect(evaluateCommandPolicy({ command: 'curl http://2852039166/' })).toEqual({
      ok: false,
      reason: 'blocked_metadata_access',
    });
  });

  it('given the metadata IP in hex encoding, should still deny', () => {
    expect(evaluateCommandPolicy({ command: 'wget http://0xA9FEA9FE/' })).toEqual({
      ok: false,
      reason: 'blocked_metadata_access',
    });
  });
});
