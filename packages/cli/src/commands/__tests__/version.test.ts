import { describe, expect, it } from 'vitest';
import { CLI_VERSION, EXIT_SUCCESS, parseArgv, versionHandler } from '@pagespace/cli';
import { createFakeContext, createRecordingSink } from '../../__tests__/fake-context.js';

describe('versionHandler', () => {
  it('writes the CLI version to stdout and exits 0', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout });
    const intent = parseArgv(['--version']);
    if (intent.kind !== 'command') throw new Error('expected command');

    const code = await versionHandler(ctx, intent);

    expect(code).toBe(EXIT_SUCCESS);
    expect(stdout.lines.join('')).toContain(CLI_VERSION);
  });

  it('emits ONLY JSON on stdout when --json is set', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout });
    const intent = parseArgv(['--version', '--json']);
    if (intent.kind !== 'command') throw new Error('expected command');

    await versionHandler(ctx, intent);

    const written = stdout.lines.join('');
    const parsed = JSON.parse(written) as { version: string };
    expect(parsed.version).toBe(CLI_VERSION);
  });
});
