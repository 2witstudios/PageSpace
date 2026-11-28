// @vitest-environment jsdom
import { beforeEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { createInitialState } from '@/ui/store/state';
import { setUiState, getUiState } from '@/ui/store/store';
import { dispatch, transactions } from '@/ui/store/transactions';
import { askImagoAboutSelection, buildAskQuote } from './RichEditor';

beforeEach(() => {
  setUiState(createInitialState());
});

describe('buildAskQuote()', () => {
  test('prefixes each selected line with "> " and ends with two newlines', () => {
    assert({
      given: 'a single selected line',
      should: 'quote it and add a blank line',
      actual: buildAskQuote('Pricing is final'),
      expected: '> Pricing is final\n\n',
    });
  });

  test('quotes every line of a multi-line selection', () => {
    assert({
      given: 'a selection spanning two lines',
      should: 'prefix both lines',
      actual: buildAskQuote('First line\nSecond line'),
      expected: '> First line\n> Second line\n\n',
    });
  });
});

describe('askImagoAboutSelection()', () => {
  test('pressing Ask puts the quote before the existing draft and opens a collapsed Imago', () => {
    dispatch(transactions.setChatDraft, 'my draft');
    dispatch(transactions.collapseImago, undefined);

    askImagoAboutSelection('Ship on Friday');

    const { resources } = getUiState();
    assert({
      given: 'an existing draft and a collapsed Imago column',
      should: 'set chatDraft to the quote followed by the existing draft',
      actual: resources.chatDraft,
      expected: '> Ship on Friday\n\nmy draft',
    });
    assert({
      given: 'a collapsed Imago column',
      should: 'reopen Imago',
      actual: resources.imagoCollapsed,
      expected: false,
    });
  });
});
