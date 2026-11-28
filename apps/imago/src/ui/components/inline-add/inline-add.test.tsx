// @vitest-environment jsdom
import { afterEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { blur, click, mount, press, typeInto, unmountAll } from '../../test-support/dom';
import { InlineAdd } from './inline-add';

afterEach(unmountAll);

const setup = () => {
  const added: string[] = [];
  const container = mount(
    <InlineAdd label="Add subtask" placeholder="Subtask title" add={(title) => added.push(title)} />,
  );
  const rest = () => container.querySelector('button');
  const field = () => container.querySelector('input');
  const open = () => {
    const button = rest();
    if (button) click(button);
    const input = field();
    if (!input) throw new Error('the field did not open');
    return input;
  };
  return { added, rest, field, open };
};

describe('InlineAdd', () => {
  test('opening', () => {
    const { rest, field, open } = setup();
    const before = { button: rest() !== null, input: field() !== null };
    const input = open();
    assert({
      given: 'activating the resting button',
      should: 'swap it for the field and move focus into it',
      actual: { before, button: rest() !== null, focused: document.activeElement === input },
      expected: { before: { button: true, input: false }, button: false, focused: true },
    });
  });

  test('Enter adds and stays open', () => {
    const { added, field, open } = setup();
    const input = open();
    typeInto(input, '  Write tests  ');
    press(input, 'Enter');
    typeInto(input, 'Ship it');
    press(input, 'Enter');
    assert({
      given: 'two titles each followed by Enter',
      should: 'add each trimmed title and keep an empty, focused field for the next',
      actual: { added, value: field()?.value, focused: document.activeElement === field() },
      expected: { added: ['Write tests', 'Ship it'], value: '', focused: true },
    });
  });

  test('Enter on a blank draft', () => {
    const { added, field, open } = setup();
    const input = open();
    typeInto(input, '   ');
    press(input, 'Enter');
    assert({
      given: 'Enter with only whitespace typed',
      should: 'add nothing and keep the field open',
      actual: { added, open: field() !== null },
      expected: { added: [], open: true },
    });
  });

  test('Escape cancels', () => {
    const { added, rest, field, open } = setup();
    typeInto(open(), 'Half a thought');
    press(field() as HTMLInputElement, 'Escape');
    const closed = field() === null;
    const focusBack = document.activeElement === rest();
    const reopened = open().value;
    assert({
      given: 'Escape with a draft, then reopening',
      should: 'close without adding, return focus to the button and forget the draft',
      actual: { added, closed, focusBack, reopened },
      expected: { added: [], closed: true, focusBack: true, reopened: '' },
    });
  });

  test('leaving the field', () => {
    const empty = setup();
    blur(empty.open());
    const drafted = setup();
    const input = drafted.open();
    typeInto(input, 'Keep me');
    blur(input);
    assert({
      given: 'focus leaving an empty field and a field with a draft',
      should: 'close the empty one and keep the draft open',
      actual: [empty.field() === null, drafted.field()?.value],
      expected: [true, 'Keep me'],
    });
  });

  test('Enter confirming an IME composition in Safari', () => {
    const { added, field, open } = setup();
    const input = open();
    typeInto(input, 'にほんご');
    const prevented = press(input, 'Enter', { keyCode: 229 });
    assert({
      given: 'the Enter Safari sends to confirm a composition (keyCode 229, isComposing false)',
      should: 'leave it to the IME: add nothing and keep the draft',
      actual: { added, prevented, value: field()?.value },
      expected: { added: [], prevented: false, value: 'にほんご' },
    });
  });
});
