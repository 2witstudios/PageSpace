import { describe, expect, it } from 'vitest';
import { EXIT_SUCCESS, helpHandler, parseArgv } from '@pagespace/cli';
import { createFakeContext, createRecordingSink } from '../../__tests__/fake-context.js';

describe('helpHandler', () => {
  it('writes human-readable usage to stdout and exits 0', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout });
    const intent = parseArgv(['help']);
    if (intent.kind !== 'command') throw new Error('expected command');

    const code = await helpHandler(ctx, intent);

    expect(code).toBe(EXIT_SUCCESS);
    expect(stdout.lines.join('')).toContain('pagespace');
  });

  it('emits ONLY JSON on stdout when --json is set', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout });
    const intent = parseArgv(['help', '--json']);
    if (intent.kind !== 'command') throw new Error('expected command');

    await helpHandler(ctx, intent);

    const written = stdout.lines.join('');
    expect(() => JSON.parse(written)).not.toThrow();
  });

  it('never writes to stderr on success', async () => {
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr });
    const intent = parseArgv(['help']);
    if (intent.kind !== 'command') throw new Error('expected command');

    await helpHandler(ctx, intent);

    expect(stderr.lines).toEqual([]);
  });
});
