import { describe, expect, it, vi } from 'vitest';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR, parseArgv } from '@pagespace/cli';
import type { CommandIntent } from '@pagespace/cli';
import { createFakeContext, createRecordingSink, fakeSdk } from '../../__tests__/fake-context.js';
import { createSheetsEditCellsHandler } from '../sheets.js';

function commandIntent(argv: string[]): CommandIntent {
  const intent = parseArgv(['__cmd__', ...argv]);
  if (intent.kind !== 'command') throw new Error('expected command');
  return { ...intent, args: intent.args.slice(1) };
}

const EDIT_RESULT = {
  pageId: 'pg_1',
  pageTitle: 'Budget',
  cellsUpdated: 1,
  operation: 'edit-cells' as const,
  stats: { valuesSet: 1, formulasSet: 0, cellsCleared: 0, sheetDimensions: { rows: 10, columns: 10 } },
  updatedCells: [{ address: 'A1', type: 'value' as const }],
};

describe('createSheetsEditCellsHandler', () => {
  it('exits 2 with a usage error when pageId is missing, never reading input', async () => {
    const editCells = vi.fn(async () => EDIT_RESULT);
    const readStdin = vi.fn(async () => '[]');
    const handler = createSheetsEditCellsHandler({ readStdin });
    const ctx = createFakeContext({ sdk: fakeSdk({ pages: { editCells } }) });

    const code = await handler(ctx, commandIntent([]));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(readStdin).not.toHaveBeenCalled();
    expect(editCells).not.toHaveBeenCalled();
  });

  it('reads cells from stdin by default and passes them through to pages.editCells', async () => {
    const editCells = vi.fn(async () => EDIT_RESULT);
    const readStdin = vi.fn(async () => '[{"address":"A1","value":"5"}]');
    const handler = createSheetsEditCellsHandler({ readStdin });
    const ctx = createFakeContext({ sdk: fakeSdk({ pages: { editCells } }) });

    const code = await handler(ctx, commandIntent(['pg_1']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(editCells).toHaveBeenCalledWith({ operation: 'edit-cells', pageId: 'pg_1', cells: [{ address: 'A1', value: '5' }] });
  });

  it('reads cells from --json-input when given, never touching stdin', async () => {
    const editCells = vi.fn(async () => EDIT_RESULT);
    const readStdin = vi.fn(async () => 'should not be used');
    const handler = createSheetsEditCellsHandler({ readStdin });
    const ctx = createFakeContext({ sdk: fakeSdk({ pages: { editCells } }) });

    const code = await handler(ctx, commandIntent(['pg_1', '--json-input', '[{"address":"B2","value":"7"}]']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(readStdin).not.toHaveBeenCalled();
    expect(editCells).toHaveBeenCalledWith({ operation: 'edit-cells', pageId: 'pg_1', cells: [{ address: 'B2', value: '7' }] });
  });

  it('rejects malformed JSON input as a usage error before any network call', async () => {
    const editCells = vi.fn(async () => EDIT_RESULT);
    const handler = createSheetsEditCellsHandler({ readStdin: async () => 'not json' });
    const ctx = createFakeContext({ sdk: fakeSdk({ pages: { editCells } }) });

    const code = await handler(ctx, commandIntent(['pg_1']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(editCells).not.toHaveBeenCalled();
  });

  it('rejects a non-array JSON input as a usage error before any network call', async () => {
    const editCells = vi.fn(async () => EDIT_RESULT);
    const handler = createSheetsEditCellsHandler({ readStdin: async () => '{"address":"A1","value":"5"}' });
    const ctx = createFakeContext({ sdk: fakeSdk({ pages: { editCells } }) });

    const code = await handler(ctx, commandIntent(['pg_1']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(editCells).not.toHaveBeenCalled();
  });

  it('--json emits exactly the SDK response', async () => {
    const stdout = createRecordingSink();
    const handler = createSheetsEditCellsHandler({ readStdin: async () => '[{"address":"A1","value":"5"}]' });
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ pages: { editCells: async () => EDIT_RESULT } }) });

    await handler(ctx, commandIntent(['pg_1', '--json']));

    expect(JSON.parse(stdout.lines.join(''))).toEqual(EDIT_RESULT);
  });

  it('surfaces an SDK failure as a runtime error', async () => {
    const editCells = vi.fn(async () => {
      throw new Error('Invalid A1-style cell address');
    });
    const stderr = createRecordingSink();
    const handler = createSheetsEditCellsHandler({ readStdin: async () => '[{"address":"A1","value":"5"}]' });
    const ctx = createFakeContext({ stderr, sdk: fakeSdk({ pages: { editCells } }) });

    const code = await handler(ctx, commandIntent(['pg_1']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain('Invalid A1-style cell address');
  });
});
