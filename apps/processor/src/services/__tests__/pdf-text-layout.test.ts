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

  it('ignores baseline movement once the page reports EOL', () => {
    assert({
      given: 'a superscript that shifts the baseline mid-line on an EOL page',
      should: 'keep the line whole — only the EOL marker breaks it',
      actual: composePageText([
        { str: 'PageSpace', hasEOL: false, transform: [1, 0, 0, 1, 0, 700] },
        { str: 'TM', hasEOL: false, transform: [1, 0, 0, 1, 0, 704] },
        { str: 'workspace', hasEOL: true, transform: [1, 0, 0, 1, 0, 700] },
      ]),
      expected: 'PageSpace TM workspace',
    });
  });
});

describe('composePageText — baseline fallback', () => {
  it('starts a new line when the baseline moves and no item reports EOL', () => {
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

  it('collapses a vertical gap to one blank line', () => {
    assert({
      given: 'several empty lines between two blocks of text',
      should: 'keep exactly one blank line as the paragraph break',
      actual: composePageText([
        eol('EXPERIENCE', true), eol('', true), eol('', true), eol('', true), eol('Founder', true),
      ]),
      expected: 'EXPERIENCE\n\nFounder',
    });
  });

  it('drops leading and trailing blank lines', () => {
    assert({
      given: 'blank lines around the page content',
      should: 'return the content with no surrounding blank lines',
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
