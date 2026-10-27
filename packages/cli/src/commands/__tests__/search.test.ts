import { describe, expect, it, vi } from 'vitest';
import {
  EXIT_RUNTIME_ERROR,
  EXIT_SUCCESS,
  EXIT_USAGE_ERROR,
  parseArgv,
  searchGlobHandler,
  searchRegexHandler,
  searchTextHandler,
} from '@pagespace/cli';
import type { CommandIntent } from '@pagespace/cli';
import { createFakeContext, createRecordingSink, fakeSdk } from '../../__tests__/fake-context.js';

/**
 * Mirrors what the router hands a handler: `parseArgv` only passes an
 * unrecognized flag (e.g. `--drive`) through into `args` once at least one
 * positional token has been seen — `__cmd__` stands in for the
 * already-stripped command path prefix and is sliced back off below.
 */
function commandIntent(argv: string[]): CommandIntent {
  const intent = parseArgv(['__cmd__', ...argv]);
  if (intent.kind !== 'command') throw new Error('expected command');
  return { ...intent, args: intent.args.slice(1) };
}

const GLOB_RESULT = {
  success: true as const,
  driveSlug: 'engineering',
  pattern: '**/README*',
  results: [
    { pageId: 'p1', title: 'README', type: 'DOCUMENT', semanticPath: '/engineering/README', matchedOn: 'title' as const },
  ],
  totalResults: 1,
  summary: 'Found 1 page matching pattern "**/README*"',
  stats: { totalPagesScanned: 42, matchingPages: 1, documentTypes: ['DOCUMENT'], matchTypes: { path: 0, title: 1 } },
  nextSteps: ['Use read_page with the pageId to examine content'],
};

const REGEX_RESULT = {
  success: true as const,
  driveSlug: 'engineering',
  pattern: 'TODO.*urgent',
  searchIn: 'content',
  results: [
    {
      pageId: 'p1',
      title: 'Design Doc',
      type: 'DOCUMENT',
      semanticPath: '/engineering/Design Doc',
      matchingLines: [{ lineNumber: 12, content: '// TODO: urgent fix needed' }],
      totalMatches: 1,
    },
  ],
  totalResults: 1,
  summary: 'Found 1 page matching pattern "TODO.*urgent"',
  stats: { pagesScanned: 10, pagesWithAccess: 1, documentTypes: ['DOCUMENT'] },
  nextSteps: ['Use read_page with the pageId to examine full content'],
};

const MULTI_DRIVE_RESULT = {
  success: true as const,
  searchQuery: 'quarterly report',
  searchType: 'text',
  results: [
    {
      driveId: 'd1',
      driveName: 'Engineering',
      driveSlug: 'engineering',
      matches: [{ pageId: 'p1', title: 'Q3 Report', type: 'DOCUMENT', excerpt: 'quarterly report summary...' }],
      count: 1,
    },
    {
      driveId: 'd2',
      driveName: 'Marketing',
      driveSlug: 'marketing',
      matches: [{ pageId: 'p2', title: 'Campaign Report', type: 'DOCUMENT', excerpt: 'quarterly report on campaign...' }],
      count: 1,
    },
  ],
  totalDrives: 2,
  totalMatches: 2,
  summary: 'Found 2 matches across 2 drives',
  stats: { drivesSearched: 2, drivesWithResults: 2, totalMatches: 2 },
  nextSteps: ['Use read_page with specific pageIds to examine content'],
};

// ---------------------------------------------------------------------------
// search text -> search.multiDrive
// ---------------------------------------------------------------------------

describe('searchTextHandler', () => {
  it('exits 2 with a usage error when the query is missing', async () => {
    const multiDrive = vi.fn(async () => MULTI_DRIVE_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ search: { multiDrive } }) });

    const code = await searchTextHandler(ctx, commandIntent([]));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(multiDrive).not.toHaveBeenCalled();
  });

  it('calls search.multiDrive with searchType "text" and no maxResultsPerDrive by default', async () => {
    const multiDrive = vi.fn(async () => MULTI_DRIVE_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ search: { multiDrive } }) });

    const code = await searchTextHandler(ctx, commandIntent(['quarterly report']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(multiDrive).toHaveBeenCalledWith({ searchQuery: 'quarterly report', searchType: 'text', maxResultsPerDrive: undefined });
  });

  it('passes --max-results through as maxResultsPerDrive', async () => {
    const multiDrive = vi.fn(async () => MULTI_DRIVE_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ search: { multiDrive } }) });

    await searchTextHandler(ctx, commandIntent(['x', '--max-results', '5']));

    expect(multiDrive).toHaveBeenCalledWith({ searchQuery: 'x', searchType: 'text', maxResultsPerDrive: 5 });
  });

  it('exits 2 when --max-results is above the multi-drive bound of 50', async () => {
    const multiDrive = vi.fn(async () => MULTI_DRIVE_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ search: { multiDrive } }) });

    const code = await searchTextHandler(ctx, commandIntent(['x', '--max-results', '51']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(multiDrive).not.toHaveBeenCalled();
  });

  it('exits 2 when --max-results is below 1', async () => {
    const multiDrive = vi.fn(async () => MULTI_DRIVE_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ search: { multiDrive } }) });

    const code = await searchTextHandler(ctx, commandIntent(['x', '--max-results', '0']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(multiDrive).not.toHaveBeenCalled();
  });

  it('exits 2 when --max-results is not an integer', async () => {
    const multiDrive = vi.fn(async () => MULTI_DRIVE_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ search: { multiDrive } }) });

    const code = await searchTextHandler(ctx, commandIntent(['x', '--max-results', 'abc']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(multiDrive).not.toHaveBeenCalled();
  });

  it('exits 2 when both --drive and --all-drives are given (mutually exclusive)', async () => {
    const multiDrive = vi.fn(async () => MULTI_DRIVE_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ search: { multiDrive } }) });

    const code = await searchTextHandler(ctx, commandIntent(['x', '--drive', 'd1', '--all-drives']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(multiDrive).not.toHaveBeenCalled();
  });

  it('accepts --all-drives as a no-op flag (multi-drive search always covers accessible drives)', async () => {
    const multiDrive = vi.fn(async () => MULTI_DRIVE_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ search: { multiDrive } }) });

    const code = await searchTextHandler(ctx, commandIntent(['x', '--all-drives']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(multiDrive).toHaveBeenCalledWith({ searchQuery: 'x', searchType: 'text', maxResultsPerDrive: undefined });
  });

  it('renders grep-style output (driveSlug:pageId: excerpt) across all drive groups by default', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ search: { multiDrive: async () => MULTI_DRIVE_RESULT } }) });

    await searchTextHandler(ctx, commandIntent(['quarterly report']));

    const output = stdout.lines.join('');
    expect(output).toBe(
      'engineering:p1: quarterly report summary...\nmarketing:p2: quarterly report on campaign...\n',
    );
  });

  it('renders only the matching drive group when --drive filters the (already-fetched) response', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ search: { multiDrive: async () => MULTI_DRIVE_RESULT } }) });

    await searchTextHandler(ctx, commandIntent(['quarterly report', '--drive', 'd2']));

    expect(stdout.lines.join('')).toBe('marketing:p2: quarterly report on campaign...\n');
  });

  it('--json emits exactly the unfiltered SDK response even when --drive is given', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ search: { multiDrive: async () => MULTI_DRIVE_RESULT } }) });

    const code = await searchTextHandler(ctx, commandIntent(['quarterly report', '--drive', 'd2', '--json']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(JSON.parse(stdout.lines.join(''))).toEqual(MULTI_DRIVE_RESULT);
  });

  it('exits 1 and surfaces the server error on API failure', async () => {
    const stderr = createRecordingSink();
    const multiDrive = vi.fn(async () => {
      throw new Error('Multi-drive search failed');
    });
    const ctx = createFakeContext({ stderr, sdk: fakeSdk({ search: { multiDrive } }) });

    const code = await searchTextHandler(ctx, commandIntent(['x']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain('Multi-drive search failed');
  });

  it('passes a query containing shell metacharacters through verbatim, unmangled', async () => {
    const multiDrive = vi.fn(async () => MULTI_DRIVE_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ search: { multiDrive } }) });
    const rawQuery = '$(rm -rf /) & echo "hi" | cat';

    await searchTextHandler(ctx, commandIntent([rawQuery]));

    expect(multiDrive).toHaveBeenCalledWith({ searchQuery: rawQuery, searchType: 'text', maxResultsPerDrive: undefined });
  });
});

// ---------------------------------------------------------------------------
// search regex -> search.regex
// ---------------------------------------------------------------------------

describe('searchRegexHandler', () => {
  it('exits 2 with a usage error when --drive is missing', async () => {
    const regex = vi.fn(async () => REGEX_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ search: { regex } }) });

    const code = await searchRegexHandler(ctx, commandIntent(['TODO.*urgent']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(regex).not.toHaveBeenCalled();
  });

  it('exits 2 with a usage error when the pattern is missing', async () => {
    const regex = vi.fn(async () => REGEX_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ search: { regex } }) });

    const code = await searchRegexHandler(ctx, commandIntent(['--drive', 'd1']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(regex).not.toHaveBeenCalled();
  });

  it('calls search.regex with driveId + pattern for the given argv', async () => {
    const regex = vi.fn(async () => REGEX_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ search: { regex } }) });

    const code = await searchRegexHandler(ctx, commandIntent(['TODO.*urgent', '--drive', 'd1']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(regex).toHaveBeenCalledWith({ driveId: 'd1', pattern: 'TODO.*urgent', searchIn: undefined, maxResults: undefined });
  });

  it('maps --in to searchIn', async () => {
    const regex = vi.fn(async () => REGEX_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ search: { regex } }) });

    await searchRegexHandler(ctx, commandIntent(['x', '--drive', 'd1', '--in', 'both']));

    expect(regex).toHaveBeenCalledWith({ driveId: 'd1', pattern: 'x', searchIn: 'both', maxResults: undefined });
  });

  it('exits 2 for an invalid --in value', async () => {
    const regex = vi.fn(async () => REGEX_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ search: { regex } }) });

    const code = await searchRegexHandler(ctx, commandIntent(['x', '--drive', 'd1', '--in', 'everywhere']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(regex).not.toHaveBeenCalled();
  });

  it('exits 2 when --max-results is above the regex bound of 100', async () => {
    const regex = vi.fn(async () => REGEX_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ search: { regex } }) });

    const code = await searchRegexHandler(ctx, commandIntent(['x', '--drive', 'd1', '--max-results', '101']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(regex).not.toHaveBeenCalled();
  });

  it('passes a pattern with regex metacharacters through verbatim, unmangled (no double-escaping)', async () => {
    const regex = vi.fn(async () => REGEX_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ search: { regex } }) });
    const rawPattern = '\\d{4}-\\d{2}-\\d{2}.*(foo|bar)+$';

    await searchRegexHandler(ctx, commandIntent([rawPattern, '--drive', 'd1']));

    expect(regex).toHaveBeenCalledWith({ driveId: 'd1', pattern: rawPattern, searchIn: undefined, maxResults: undefined });
  });

  it('renders grep-style output (path:pageId:line: content) per matching line', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ search: { regex: async () => REGEX_RESULT } }) });

    await searchRegexHandler(ctx, commandIntent(['TODO.*urgent', '--drive', 'd1']));

    expect(stdout.lines.join('')).toBe('/engineering/Design Doc:p1:12: // TODO: urgent fix needed\n');
  });

  it('--json emits exactly the SDK response and nothing else on stdout', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ search: { regex: async () => REGEX_RESULT } }) });

    const code = await searchRegexHandler(ctx, commandIntent(['TODO.*urgent', '--drive', 'd1', '--json']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(JSON.parse(stdout.lines.join(''))).toEqual(REGEX_RESULT);
  });

  it('exits 1 and surfaces the server error on API failure', async () => {
    const stderr = createRecordingSink();
    const regex = vi.fn(async () => {
      throw new Error('Pattern parameter is required');
    });
    const ctx = createFakeContext({ stderr, sdk: fakeSdk({ search: { regex } }) });

    const code = await searchRegexHandler(ctx, commandIntent(['x', '--drive', 'd1']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain('Pattern parameter is required');
  });
});

// ---------------------------------------------------------------------------
// search glob -> search.glob
// ---------------------------------------------------------------------------

describe('searchGlobHandler', () => {
  it('exits 2 with a usage error when --drive is missing', async () => {
    const glob = vi.fn(async () => GLOB_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ search: { glob } }) });

    const code = await searchGlobHandler(ctx, commandIntent(['**/README*']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(glob).not.toHaveBeenCalled();
  });

  it('calls search.glob with driveId + pattern for the given argv', async () => {
    const glob = vi.fn(async () => GLOB_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ search: { glob } }) });

    const code = await searchGlobHandler(ctx, commandIntent(['**/README*', '--drive', 'd1']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(glob).toHaveBeenCalledWith({ driveId: 'd1', pattern: '**/README*', maxResults: undefined });
  });

  it('exits 2 when --max-results is above the glob bound of 200', async () => {
    const glob = vi.fn(async () => GLOB_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ search: { glob } }) });

    const code = await searchGlobHandler(ctx, commandIntent(['*', '--drive', 'd1', '--max-results', '201']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(glob).not.toHaveBeenCalled();
  });

  it('passes a pattern with glob stars through verbatim, unmangled', async () => {
    const glob = vi.fn(async () => GLOB_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ search: { glob } }) });
    const rawPattern = '**/*.{md,ts}';

    await searchGlobHandler(ctx, commandIntent([rawPattern, '--drive', 'd1']));

    expect(glob).toHaveBeenCalledWith({ driveId: 'd1', pattern: rawPattern, maxResults: undefined });
  });

  it('renders grep-style output (path:pageId: title)', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ search: { glob: async () => GLOB_RESULT } }) });

    await searchGlobHandler(ctx, commandIntent(['**/README*', '--drive', 'd1']));

    expect(stdout.lines.join('')).toBe('/engineering/README:p1: README\n');
  });

  it('--json emits exactly the SDK response and nothing else on stdout', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ search: { glob: async () => GLOB_RESULT } }) });

    const code = await searchGlobHandler(ctx, commandIntent(['**/README*', '--drive', 'd1', '--json']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(JSON.parse(stdout.lines.join(''))).toEqual(GLOB_RESULT);
  });

  it('exits 1 and surfaces the server error on API failure', async () => {
    const stderr = createRecordingSink();
    const glob = vi.fn(async () => {
      throw new Error('Drive not found');
    });
    const ctx = createFakeContext({ stderr, sdk: fakeSdk({ search: { glob } }) });

    const code = await searchGlobHandler(ctx, commandIntent(['*', '--drive', 'd1']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain('Drive not found');
  });
});
