import { describe, expect, it, vi } from 'vitest';
import type { PageSpaceClient } from '@pagespace/sdk';
import { parseArgv } from '../../../argv/parse.js';
import type { CommandIntent } from '../../../argv/parse.js';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from '../../../exit-codes.js';
import { createFakeContext, createRecordingSink } from '../../../__tests__/fake-context.js';
import { keysDescribeHandler, parseKeysDescribeArgs, renderKeyDescription } from '../describe.js';

function commandIntent(argv: string[]): CommandIntent {
  const parsed = parseArgv(argv);
  if (parsed.kind !== 'command') throw new Error('expected command');
  return { ...parsed, args: parsed.args.slice(2) };
}

function fakeSdk(invoke: ReturnType<typeof vi.fn>): PageSpaceClient {
  return { invoke } as unknown as PageSpaceClient;
}

const MEMBER_KEY = {
  credential: {
    type: 'mcp' as const,
    scoped: true,
    id: 'k1',
    name: 'lead-gen agent',
    tokenPrefix: 'mcp_abcdefghijk',
    createdAt: '2026-08-22T00:00:00.000Z',
    lastUsed: '2026-08-22T10:00:00.000Z',
  },
  driveScopes: [
    {
      id: 'd1',
      name: 'Engineering',
      role: 'MEMBER' as const,
      customRoleId: null,
      customRoleName: null,
      roleSource: 'explicit' as const,
      permissions: { canView: true, canEdit: true, canShare: false, canDelete: false },
    },
  ],
  page: null,
};

describe('renderKeyDescription', () => {
  // The exact question issue #2470 was left unable to answer: the key read
  // fine and every write failed, and nothing said why.
  it('states what the key can do, not only the role it was granted', () => {
    const output = renderKeyDescription(MEMBER_KEY);
    expect(output).toContain('role member');
    expect(output).toContain('on the drive: view edit');
  });

  // The drive-as-root-node answer grants edit to ANY membership, while a
  // document inside that drive can still be view-only for the same key — the
  // "reads fine, every write fails" shape of #2470. An unqualified "can: …"
  // line would tell an agent it may write to pages it cannot.
  it('labels the drive-level line for what it covers rather than leaving it bare', () => {
    expect(renderKeyDescription(MEMBER_KEY)).not.toMatch(/^ +can: /m);
  });

  it('points at --page when no page was asked about, since a page can be narrower', () => {
    expect(renderKeyDescription(MEMBER_KEY)).toContain('keys describe --page <pageId>');
  });

  it('resolves a named page separately from its drive', () => {
    const output = renderKeyDescription({
      ...MEMBER_KEY,
      page: { id: 'pg1', permissions: { canView: true, canEdit: false, canShare: false, canDelete: false } },
    });
    expect(output).toContain('on the drive: view edit');
    expect(output).toContain('Page pg1: view');
    expect(output).not.toContain('Page pg1: view edit');
  });

  // "You cannot see this page" and "you may do nothing with this page" are
  // different answers, and an agent choosing where to write needs both.
  it('says an unreachable page is out of reach rather than showing it as all-denied', () => {
    const output = renderKeyDescription({ ...MEMBER_KEY, page: { id: 'pg9', permissions: null } });
    expect(output).toContain('out of reach');
    expect(output).not.toContain('nothing (no access here)');
  });

  it('still answers the --page question when no drive is reachable at all', () => {
    const output = renderKeyDescription({
      ...MEMBER_KEY,
      driveScopes: [],
      page: { id: 'pg9', permissions: null },
    });
    expect(output).toContain('No drives are reachable');
    expect(output).toContain('Page pg9');
  });

  it('names the key and its prefix so it can be matched against `keys list`', () => {
    const output = renderKeyDescription(MEMBER_KEY);
    expect(output).toContain('lead-gen agent');
    expect(output).toContain('mcp_abcdefghijk');
  });

  it('never prints an identity — a key must not yield the person behind it', () => {
    expect(renderKeyDescription(MEMBER_KEY)).not.toMatch(/@|e-?mail/i);
  });

  it('spells out an inherit grant instead of showing a blank role', () => {
    const output = renderKeyDescription({
      ...MEMBER_KEY,
      driveScopes: [{ ...MEMBER_KEY.driveScopes[0], role: null, roleSource: 'inherited' as const }],
    });
    expect(output).toContain('inherits your own access');
  });

  it('prints a custom role by name', () => {
    const output = renderKeyDescription({
      ...MEMBER_KEY,
      driveScopes: [
        {
          ...MEMBER_KEY.driveScopes[0],
          role: null,
          customRoleId: 'r1',
          customRoleName: 'Researcher',
          roleSource: 'custom' as const,
        },
      ],
    });
    expect(output).toContain('custom role "Researcher"');
  });

  it('says a drive grants nothing rather than printing an empty capability line', () => {
    const output = renderKeyDescription({
      ...MEMBER_KEY,
      driveScopes: [
        {
          ...MEMBER_KEY.driveScopes[0],
          permissions: { canView: false, canEdit: false, canShare: false, canDelete: false },
        },
      ],
    });
    expect(output).toContain('nothing (no access here)');
  });

  it('says so out loud when no drive is reachable, instead of showing an empty list', () => {
    const output = renderKeyDescription({ ...MEMBER_KEY, driveScopes: [] });
    expect(output).toContain('No drives are reachable');
  });

  it('describes an unrestricted credential as unrestricted, not as "0 drives"', () => {
    const output = renderKeyDescription({
      ...MEMBER_KEY,
      credential: { ...MEMBER_KEY.credential, scoped: false },
    });
    expect(output).toContain('unrestricted');
  });

  it('omits the key-row fields for a credential that has none (a personal login)', () => {
    const output = renderKeyDescription({
      credential: { type: 'oauth', scoped: false, id: null, name: null, tokenPrefix: null, createdAt: null, lastUsed: null },
      driveScopes: MEMBER_KEY.driveScopes,
      page: null,
    });
    expect(output).toContain('personal login');
    expect(output).not.toContain('Prefix:');
    expect(output).not.toContain('Last used:');
  });
});

describe('parseKeysDescribeArgs', () => {
  it('accepts no arguments', () => {
    expect(parseKeysDescribeArgs([])).toEqual({ ok: true });
  });

  it('accepts --page <pageId>', () => {
    expect(parseKeysDescribeArgs(['--page', 'pg1'])).toEqual({ ok: true, pageId: 'pg1' });
  });

  it.each([['--page'], ['--page', '--json'], ['pg1'], ['--page', 'pg1', 'extra']])(
    'rejects %j with a usage message',
    (...rest) => {
      const result = parseKeysDescribeArgs(rest);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.message).toContain('--page <pageId>');
    },
  );
});

describe('keysDescribeHandler', () => {
  it('passes --page through to the operation', async () => {
    const invoke = vi.fn(async () => MEMBER_KEY);
    const ctx = createFakeContext({ sdk: fakeSdk(invoke) });

    await keysDescribeHandler(ctx, commandIntent(['keys', 'describe', '--page', 'pg1']));

    expect(invoke).toHaveBeenCalledWith(expect.anything(), { pageId: 'pg1' });
  });

  it('sends no pageId when none was given, rather than an empty one', async () => {
    const invoke = vi.fn(async () => MEMBER_KEY);
    const ctx = createFakeContext({ sdk: fakeSdk(invoke) });

    await keysDescribeHandler(ctx, commandIntent(['keys', 'describe']));

    expect(invoke).toHaveBeenCalledWith(expect.anything(), {});
  });

  it('rejects a malformed flag as a usage error without a round trip', async () => {
    const invoke = vi.fn();
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr, sdk: fakeSdk(invoke) });

    const code = await keysDescribeHandler(ctx, commandIntent(['keys', 'describe', '--page']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('renders the server\'s description', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk(vi.fn(async () => MEMBER_KEY)) });

    const code = await keysDescribeHandler(ctx, commandIntent(['keys', 'describe']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(stdout.lines.join('')).toContain('lead-gen agent');
  });

  it('emits the raw description as JSON with --json', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk(vi.fn(async () => MEMBER_KEY)) });

    const code = await keysDescribeHandler(ctx, commandIntent(['keys', 'describe', '--json']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(JSON.parse(stdout.lines.join(''))).toEqual(MEMBER_KEY);
  });

  // Unlike the management verbs, this one is not refused under a key — it is
  // the verb a key CAN run about itself.
  it('runs under a scoped access key', async () => {
    const invoke = vi.fn(async () => MEMBER_KEY);
    const ctx = createFakeContext({ sdk: fakeSdk(invoke), credentialKind: 'key' });

    const code = await keysDescribeHandler(ctx, commandIntent(['keys', 'describe']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(invoke).toHaveBeenCalled();
  });

  it('exits 1 when the SDK call fails', async () => {
    const stderr = createRecordingSink();
    const ctx = createFakeContext({
      stderr,
      sdk: fakeSdk(
        vi.fn(async () => {
          throw new Error('server unreachable');
        }),
      ),
    });

    const code = await keysDescribeHandler(ctx, commandIntent(['keys', 'describe']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain('server unreachable');
  });
});
