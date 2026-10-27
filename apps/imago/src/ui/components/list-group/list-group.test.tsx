import { renderToString } from 'react-dom/server';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { ListGroup } from './list-group';
import { renderListGroup } from './list-group.render';

describe('ListGroup', () => {
  test('renders through renderListGroup', () => {
    const rows = <li>Noah Hines</li>;
    assert({
      given: 'a label and a row',
      should: 'render exactly what the pure render function renders',
      actual: renderToString(<ListGroup label="Today">{rows}</ListGroup>),
      expected: renderToString(renderListGroup({ label: 'Today', children: rows })),
    });
  });
});
