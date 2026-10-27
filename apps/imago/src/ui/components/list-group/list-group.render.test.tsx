import { renderToString } from 'react-dom/server';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { listGroupLabelClass, listGroupRowsClass } from './list-group-class';
import { renderListGroup } from './list-group.render';

const html = renderToString(
  renderListGroup({
    label: 'Direct messages',
    children: (
      <>
        <li>Noah Hines</li>
        <li>Ada Park</li>
      </>
    ),
  }),
);

describe('renderListGroup', () => {
  test('a named region of rows', () => {
    assert({
      given: 'a label and two rows',
      should: 'name a region by the label, head it with the label, and list the rows in order',
      actual: html,
      expected:
        `<section aria-label="Direct messages">` +
        `<h2 class="${listGroupLabelClass}">Direct messages</h2>` +
        `<ul class="${listGroupRowsClass}"><li>Noah Hines</li><li>Ada Park</li></ul>` +
        `</section>`,
    });
  });

  test('sentence case', () => {
    assert({
      given: 'a sentence-case label',
      should: 'never shout it',
      actual: html.includes('uppercase'),
      expected: false,
    });
  });
});
