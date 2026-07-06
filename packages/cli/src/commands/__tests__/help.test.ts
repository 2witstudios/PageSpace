import { describe, expect, it } from 'vitest';
import { EXIT_SUCCESS, groupHelpCommands, helpHandler, parseArgv, ROUTES } from '@pagespace/cli';
import type { HelpCommandDescriptor } from '@pagespace/cli';
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

  it('lists every registered command, not a hardcoded handful', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout });
    const intent = parseArgv(['help']);
    if (intent.kind !== 'command') throw new Error('expected command');

    await helpHandler(ctx, intent);

    expect(ROUTES.length).toBeGreaterThan(30);
    const output = stdout.lines.join('');
    for (const route of ROUTES) {
      expect(output).toContain(route.path.join(' '));
    }
  });

  it('groups commands under resource headers with a runnable example each', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout });
    const intent = parseArgv(['help']);
    if (intent.kind !== 'command') throw new Error('expected command');

    await helpHandler(ctx, intent);

    const output = stdout.lines.join('');
    for (const title of ['Auth:', 'Drives:', 'Pages:', 'Search:', 'Tasks:', 'Agents:', 'Tokens:', 'MCP:']) {
      expect(output).toContain(title);
    }
    expect(output).toContain('e.g. pagespace login');
    expect(output).toContain('e.g. pagespace tokens create --drive <id> --role member --save-as-profile agent');
  });
});

describe('groupHelpCommands', () => {
  const DESCRIPTORS: readonly HelpCommandDescriptor[] = [
    { path: ['login'], summary: 'Log in' },
    { path: ['whoami'], summary: 'Show identity' },
    { path: ['drives', 'list'], summary: 'List drives' },
    { path: ['trash', 'list'], summary: 'List trashed pages/drives' },
    { path: ['pages', 'read'], summary: 'Read page content' },
    { path: ['sheets', 'edit-cells'], summary: 'Edit sheet cells' },
    { path: ['tokens', 'create'], summary: 'Mint a new MCP access token' },
    { path: ['mcp'], summary: 'Serve the MCP stdio server' },
    { path: ['activity'], summary: 'Show recent activity' },
  ];

  it('assigns every command to exactly one group, dropping none', () => {
    const groups = groupHelpCommands(DESCRIPTORS);
    const grouped = groups.flatMap((g) => g.commands);
    expect(grouped).toHaveLength(DESCRIPTORS.length);
    expect(new Set(grouped.map((c) => c.path.join(' ')))).toEqual(new Set(DESCRIPTORS.map((c) => c.path.join(' '))));
  });

  it('groups by resource: auth, drives (incl. trash), pages (incl. sheets), tokens, mcp, other', () => {
    const groups = groupHelpCommands(DESCRIPTORS);
    const byTitle = new Map(groups.map((g) => [g.title, g.commands.map((c) => c.path.join(' '))]));

    expect(byTitle.get('Auth')).toEqual(['login', 'whoami']);
    expect(byTitle.get('Drives')).toEqual(['drives list', 'trash list']);
    expect(byTitle.get('Pages')).toEqual(['pages read', 'sheets edit-cells']);
    expect(byTitle.get('Tokens')).toEqual(['tokens create']);
    expect(byTitle.get('MCP')).toEqual(['mcp']);
    expect(byTitle.get('Other')).toEqual(['activity']);
  });

  it('omits groups with no matching commands', () => {
    const groups = groupHelpCommands([{ path: ['login'], summary: 'Log in' }]);
    expect(groups).toHaveLength(1);
    expect(groups[0].title).toBe('Auth');
  });
});
