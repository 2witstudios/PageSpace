// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { click, mount, unmountAll } from '@/ui/test-support/dom';
import { renderErrorState } from '@/ui/frame/edge-state/edge-state.render';
import ShellError from './error';

afterEach(unmountAll);

const thrown = Object.assign(new Error('connect ECONNREFUSED 10.0.0.7:5432 password=hunter2'), { digest: 'd-123' });

describe('the shell’s error boundary', () => {
  test('lives inside the shell', () => {
    assert({
      given: 'the app directory',
      should: 'put the boundary in (shell), below its layout, as a client component, so a failure keeps the rail and panes',
      actual: [
        existsSync(join(__dirname, 'error.tsx')),
        readFileSync(join(__dirname, 'error.tsx'), 'utf8').startsWith("'use client';"),
      ],
      expected: [true, true],
    });
  });

  test('a route that threw', () => {
    assert({
      given: 'an error whose message carries server internals',
      should: 'draw the retryable error object, with none of the message',
      actual: renderToStaticMarkup(<ShellError error={thrown} reset={() => {}} />),
      expected: renderToStaticMarkup(renderErrorState({ title: 'Something went wrong', retry: () => {} })),
    });
  });

  test('Try again', () => {
    const reset = vi.fn();
    const container = mount(<ShellError error={thrown} reset={reset} />);
    click(container.querySelector('button') as HTMLButtonElement);
    assert({
      given: 'a click on Try again',
      should: 'ask Next to render the route again',
      actual: reset.mock.calls.length,
      expected: 1,
    });
  });
});
