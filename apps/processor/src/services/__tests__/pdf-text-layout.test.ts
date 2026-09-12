import { describe, it } from 'vitest';
import { assert } from '../../__tests__/riteway';
import { composePageText, composeDocumentText, type PdfTextItem } from '../pdf-text-layout';

/** pdf.js item with an explicit end-of-line marker. */
const eol = (str: string, hasEOL = false): PdfTextItem => ({ str, hasEOL });

/** pdf.js item positioned by baseline only (no hasEOL anywhere on the page). */
const at = (str: string, y: number): PdfTextItem => ({ str, transform: [1, 0, 0, 1, 0, y] });

describe('composePageText — hasEOL', () => {
  it('breaks the line where pdf.js says the line ends', () => {
    assert({
      given: 'three runs with an EOL on the first and second',
      should: 'produce three lines, not one run-on paragraph',
      actual: composePageText([
        eol('JONATHAN WOODALL', true),
        eol('Founder & AI Systems Builder', true),
        eol('Dallas-Fort Worth'),
      ]),
      expected: 'JONATHAN WOODALL\nFounder & AI Systems Builder\nDallas-Fort Worth',
    });
  });

  it('joins the runs that make up one line', () => {
    assert({
      given: 'a line split into several runs, only the last marked EOL',
      should: 'join them into a single line',
      actual: composePageText([eol('Founder'), eol('& Creator'), eol('| PageSpace.AI', true)]),
      expected: 'Founder & Creator | PageSpace.AI',
    });
  });

  it('still breaks on geometry where a page is only partly annotated', () => {
    assert({
      given: 'a page where pdf.js marked one line end and left two to geometry',
      should: 'break on all three, not treat one marker as proof the page is annotated',
      actual: composePageText([
        { str: 'EXPERIENCE', hasEOL: true, transform: [1, 0, 0, 1, 0, 700], height: 10 },
        { str: 'Founder & Creator', transform: [1, 0, 0, 1, 0, 688], height: 10 },
        { str: 'Feb 2025 - Present', transform: [1, 0, 0, 1, 0, 676], height: 10 },
      ]),
      expected: 'EXPERIENCE\nFounder & Creator\nFeb 2025 - Present',
    });
  });
});

describe('composePageText — inline baseline shifts are not line breaks', () => {
  it('keeps a superscript on its line', () => {
    assert({
      given: 'a run that rises above the baseline and returns',
      should: 'keep the line whole — only a DOWNWARD move starts a line',
      actual: composePageText([
        { str: 'PageSpace', transform: [1, 0, 0, 1, 0, 700], height: 10 },
        { str: 'TM', transform: [1, 0, 0, 1, 0, 704], height: 6 },
        { str: 'workspace', transform: [1, 0, 0, 1, 0, 700], height: 10 },
      ]),
      expected: 'PageSpace TM workspace',
    });
  });

  it('keeps a subscript on its line', () => {
    assert({
      given: 'a run dipping 3 units below a 10-unit-tall line',
      should: 'keep the line whole — the dip is under half the glyph height',
      actual: composePageText([
        { str: 'H', transform: [1, 0, 0, 1, 0, 700], height: 10 },
        { str: '2', transform: [1, 0, 0, 1, 0, 697], height: 6 },
        { str: 'O is water', transform: [1, 0, 0, 1, 0, 700], height: 10 },
      ]),
      expected: 'H 2 O is water',
    });
  });

  it('measures the drop from the line baseline, not the run before it', () => {
    assert({
      given: 'a superscript followed by a genuine new line',
      should: 'break once, at the new line — not at the return from the superscript',
      actual: composePageText([
        { str: 'title', transform: [1, 0, 0, 1, 0, 700], height: 10 },
        { str: 'TM', transform: [1, 0, 0, 1, 0, 706], height: 6 },
        { str: 'body text', transform: [1, 0, 0, 1, 0, 688], height: 10 },
      ]),
      expected: 'title TM\nbody text',
    });
  });

  it('scales the tolerance to the glyph height', () => {
    assert({
      given: 'a 6-unit dip inside display text 30 units tall',
      should: 'keep it on one line, where the same dip in body text would break',
      actual: composePageText([
        { str: 'PAGE', transform: [1, 0, 0, 1, 0, 700], height: 30 },
        { str: 'SPACE', transform: [1, 0, 0, 1, 0, 694], height: 30 },
      ]),
      expected: 'PAGE SPACE',
    });
  });

  it('breaks that same dip in body text', () => {
    assert({
      given: 'a 6-unit drop between runs 10 units tall',
      should: 'break — it clears half the glyph height',
      actual: composePageText([
        { str: 'PAGE', transform: [1, 0, 0, 1, 0, 700], height: 10 },
        { str: 'SPACE', transform: [1, 0, 0, 1, 0, 694], height: 10 },
      ]),
      expected: 'PAGE\nSPACE',
    });
  });
});

describe('composePageText — baseline geometry', () => {
  it('starts a new line when the baseline drops', () => {
    assert({
      given: 'runs on three descending baselines with no hasEOL',
      should: 'break on the baseline changes',
      actual: composePageText([at('SUMMARY', 700), at('Founder and', 688), at('engineer', 676)]),
      expected: 'SUMMARY\nFounder and\nengineer',
    });
  });

  it('keeps runs that share a baseline on one line', () => {
    assert({
      given: 'three runs on the same baseline',
      should: 'join them rather than break on float noise',
      actual: composePageText([at('AI', 700), at('&', 700.4), at('Agents:', 699.6)]),
      expected: 'AI & Agents:',
    });
  });
});

describe('composePageText — tidying', () => {
  it('collapses the padding runs PDF word-positioning emits', () => {
    assert({
      given: 'empty and whitespace runs between words',
      should: 'leave single spaces and no leading or trailing space',
      actual: composePageText([eol(' '), eol('Founder'), eol(''), eol('   '), eol('& Creator'), eol('  ', true)]),
      expected: 'Founder & Creator',
    });
  });

  it('emits no blank line for the empty markers pdf.js ends lines with', () => {
    assert({
      given: 'empty EOL items between two blocks of text',
      should: 'emit two lines, not a blank line per marker',
      actual: composePageText([
        eol('EXPERIENCE', true), eol('', true), eol('', true), eol('', true), eol('Founder', true),
      ]),
      expected: 'EXPERIENCE\nFounder',
    });
  });

  it('emits no blank line when a marker carries the next line\'s baseline', () => {
    assert({
      given: 'the real pdf.js shape — an empty EOL item positioned on the line below',
      should: 'break once, with no blank line between the two lines',
      actual: composePageText([
        { str: 'SUMMARY', transform: [1, 0, 0, 1, 0, 700], height: 10 },
        { str: '', hasEOL: true, transform: [1, 0, 0, 1, 0, 688], height: 10 },
        { str: 'Founder and self-taught', transform: [1, 0, 0, 1, 0, 688], height: 10 },
        { str: '', hasEOL: true, transform: [1, 0, 0, 1, 0, 676], height: 10 },
      ]),
      expected: 'SUMMARY\nFounder and self-taught',
    });
  });

  it('drops leading and trailing empty markers', () => {
    assert({
      given: 'empty markers around the page content',
      should: 'return the content alone',
      actual: composePageText([eol('', true), eol('EDUCATION', true), eol('', true)]),
      expected: 'EDUCATION',
    });
  });

  it('returns an empty string for a page with no text', () => {
    assert({
      given: 'a page whose items are all empty',
      should: 'return an empty string',
      actual: composePageText([eol('', true), eol('  ', true)]),
      expected: '',
    });
  });

  it('returns an empty string for a page with no items', () => {
    assert({ given: 'no items', should: 'return an empty string', actual: composePageText([]), expected: '' });
  });
});

describe('composeDocumentText', () => {
  it('separates pages with a blank line', () => {
    assert({
      given: 'two composed page texts',
      should: 'join them with a blank line so a page break survives',
      actual: composeDocumentText(['page one\nline two', 'page two']),
      expected: 'page one\nline two\n\npage two',
    });
  });
});
