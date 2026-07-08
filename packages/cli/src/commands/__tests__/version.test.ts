import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLI_VERSION, EXIT_SUCCESS, parseArgv, versionHandler } from '@pagespace/cli';
import { createFakeContext, createRecordingSink } from '../../__tests__/fake-context.js';

describe('CLI_VERSION', () => {
  it('strictly equals package.json "version" — same drift guard as the SDK\'s SDK_VERSION test, so bumping either side alone fails the suite', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(CLI_VERSION).toBe(packageJson.version);
  });
});

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
