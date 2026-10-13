import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import {
  paletteDriveClass,
  paletteFieldClass,
  paletteInputClass,
  paletteLayerClass,
  paletteListClass,
  paletteNoteClass,
  paletteRowClass,
  paletteScopeClass,
  paletteSheetClass,
  paletteTitleClass,
} from './palette-class';

describe('palette classes', () => {
  test('layer and sheet', () => {
    assert({
      given: 'the palette over the frame',
      should: 'cover the frame above the panes and hold a raised glass sheet a document column wide',
      actual: [paletteLayerClass, paletteSheetClass],
      expected: [
        'fixed inset-0 z-popover flex items-start justify-center px-4 pt-16',
        'flex w-full max-w-doc flex-col overflow-hidden rounded-xl border border-hairline shadow-3 surface-glass-raised',
      ],
    });
  });

  test('field', () => {
    assert({
      given: 'the field row, its input and the scope toggle',
      should: 'be a hairline-ruled row with a borderless composer-height input',
      actual: [paletteFieldClass, paletteInputClass, paletteScopeClass],
      expected: [
        'flex items-center gap-2 border-b border-hairline px-3 text-ink-muted',
        'h-composer-field min-w-0 flex-1 border-none bg-transparent text-base text-ink outline-none placeholder:text-ink-faint',
        'flex flex-none items-center gap-2 text-xs text-ink-muted',
      ],
    });
  });

  test('results', () => {
    assert({
      given: 'the list, a highlighted row and a quiet one',
      should: 'tint only the highlighted row, at full ink',
      actual: [paletteListClass, paletteRowClass(true), paletteRowClass(false)],
      expected: [
        'm-0 flex list-none flex-col gap-1 p-1',
        'flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg px-2 text-left text-sm transition-colors duration-120 ease-standard bg-accent-soft text-ink',
        'flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg px-2 text-left text-sm transition-colors duration-120 ease-standard text-ink-muted',
      ],
    });
  });

  test('labels', () => {
    assert({
      given: 'a result’s title, its drive and the note under the field',
      should: 'truncate the title, keep the drive faint and the note muted',
      actual: [paletteTitleClass, paletteDriveClass, paletteNoteClass],
      expected: [
        'min-w-0 flex-1 truncate',
        'flex-none truncate text-2xs text-ink-faint',
        'px-3 py-row-y text-sm text-ink-muted',
      ],
    });
  });
});
