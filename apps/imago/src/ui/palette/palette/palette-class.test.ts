import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import {
  paletteDriveClass,
  paletteFieldClass,
  paletteInputClass,
  paletteKbdClass,
  paletteLayerClass,
  paletteListClass,
  paletteNoteClass,
  paletteRowClass,
  paletteScopeClass,
  paletteScopeOptionClass,
  paletteSheetClass,
  paletteTileClass,
  paletteTitleClass,
} from './palette-class';

describe('palette classes', () => {
  test('layer and sheet', () => {
    assert({
      given: 'the palette over the frame',
      should: 'cover the frame above the panes and hold a raised glass sheet the palette’s width, no taller than the viewport',
      actual: [paletteLayerClass, paletteSheetClass],
      expected: [
        'fixed inset-0 z-popover flex items-start justify-center px-4 pt-16',
        'flex max-h-palette-sheet w-full max-w-palette flex-col overflow-hidden rounded-xl border border-hairline shadow-3 surface-glass-raised',
      ],
    });
  });

  test('the input never draws a halo', () => {
    assert({
      given: 'the palette input',
      should: 'drop the global focus halo, which the sheet would clip at its top',
      actual: paletteInputClass.includes('focus-visible:shadow-none'),
      expected: true,
    });
  });

  test('field', () => {
    assert({
      given: 'the field row, its input and the scope switch',
      should: 'be a hairline-ruled row with a borderless input filling it, and a sunken two-segment track',
      actual: [paletteFieldClass, paletteInputClass, paletteScopeClass],
      expected: [
        'flex h-palette-field flex-none items-center gap-3 border-b border-hairline pr-3 pl-4',
        'h-full min-w-0 flex-1 border-none bg-transparent text-md tracking-tight text-ink outline-none placeholder:text-ink-faint focus-visible:shadow-none',
        'flex flex-none gap-1 rounded-md border border-hairline bg-surface-sunken p-1',
      ],
    });
  });

  test('scope segments', () => {
    assert({
      given: 'the selected segment and the other',
      should: 'raise only the selected one, and cut a long drive name short',
      actual: [
        paletteScopeOptionClass(true).includes('bg-surface-overlay'),
        paletteScopeOptionClass(false).includes('bg-surface-overlay'),
        ['max-w-palette-scope', 'truncate'].every((name) => paletteScopeOptionClass(true).split(' ').includes(name)),
      ],
      expected: [true, false, true],
    });
  });

  test('results', () => {
    assert({
      given: 'the list, a highlighted row and a quiet one',
      should: 'scroll the list inside the sheet, and tint only the highlighted row and its icon tile',
      actual: [
        paletteListClass,
        paletteRowClass(true),
        paletteRowClass(false),
        paletteTileClass(true).includes('bg-accent-soft'),
        paletteTileClass(false).includes('bg-accent-soft'),
      ],
      expected: [
        'm-0 flex min-h-0 flex-1 list-none flex-col overflow-y-auto px-2 pt-1 pb-2',
        'flex h-palette-row w-full cursor-pointer items-center gap-3 rounded-lg px-2 text-left text-base text-ink transition-colors duration-120 ease-standard bg-accent-soft',
        'flex h-palette-row w-full cursor-pointer items-center gap-3 rounded-lg px-2 text-left text-base text-ink transition-colors duration-120 ease-standard',
        true,
        false,
      ],
    });
  });

  test('labels and key caps', () => {
    assert({
      given: 'a result’s title, its drive, the note under the field, and a footer and a row key cap',
      should: 'truncate the title and drive, keep the note muted, raise the footer key and tint the row’s',
      actual: [
        paletteTitleClass,
        paletteDriveClass,
        paletteNoteClass,
        paletteKbdClass('key').includes('shadow-1'),
        paletteKbdClass('accent').includes('bg-accent-soft'),
      ],
      expected: ['truncate font-medium', 'truncate text-xs text-ink-faint', 'flex-none px-4 py-3 text-sm text-ink-muted', true, true],
    });
  });
});
