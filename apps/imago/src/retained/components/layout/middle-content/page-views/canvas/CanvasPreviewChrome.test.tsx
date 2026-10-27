// @vitest-environment jsdom
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { act } from 'react';
import { mount, unmountAll } from '@/ui/test-support/dom';
import { CanvasFormTargetFooter, CanvasPreviewHeader } from './CanvasPreviewChrome';

const responses = vi.hoisted(() => ({ byUrl: new Map<string, unknown>() }));
vi.mock('@/retained/lib/auth/auth-fetch', () => ({
  fetchWithAuth: async (url: string) => {
    const body = responses.byUrl.get(url);
    return { ok: body !== undefined, json: async () => body };
  },
}));

const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

beforeEach(() => {
  responses.byUrl.clear();
});

afterEach(unmountAll);

describe('CanvasPreviewHeader', () => {
  test('labels the preview and reports that it matches the app theme', () => {
    const container = mount(<CanvasPreviewHeader themeBridgeEnabled onFullscreen={() => undefined} />);
    assert({
      given: 'a canvas whose appearance follows the app theme',
      should: 'show "Canvas preview" and "Matches app theme"',
      actual: [container.textContent?.includes('Canvas preview'), container.textContent?.includes('Matches app theme')],
      expected: [true, true],
    });
  });

  test('reports a fixed appearance when the theme bridge is off', () => {
    const container = mount(<CanvasPreviewHeader themeBridgeEnabled={false} onFullscreen={() => undefined} />);
    assert({
      given: 'a canvas whose appearance is fixed',
      should: 'not claim it matches the app theme',
      actual: container.textContent?.includes('Matches app theme'),
      expected: false,
    });
  });

  test('opens fullscreen preview from its labelled button', () => {
    let opened = 0;
    const container = mount(<CanvasPreviewHeader themeBridgeEnabled onFullscreen={() => { opened += 1; }} />);
    (container.querySelector('[aria-label="Fullscreen preview"]') as HTMLButtonElement).click();
    assert({
      given: 'the Fullscreen preview button',
      should: 'call onFullscreen once when clicked',
      actual: opened,
      expected: 1,
    });
  });
});

describe('CanvasFormTargetFooter', () => {
  test('names the wired sheet and its state when an active form target exists', async () => {
    responses.byUrl.set('/api/pages/p1/form-target', { formTargets: [{ sheetPageId: 's1', status: 'active' }] });
    responses.byUrl.set('/api/pages/s1', { title: 'Waitlist Signups' });
    const container = mount(<CanvasFormTargetFooter pageId="p1" />);
    await flush();
    assert({
      given: 'a canvas with an active form target',
      should: 'show "Wired form → <sheet> · Active"',
      actual: container.textContent,
      expected: 'Wired form → Waitlist Signups · Active',
    });
  });

  test('renders nothing when the page has no form target', async () => {
    responses.byUrl.set('/api/pages/p1/form-target', { formTargets: [] });
    const container = mount(<CanvasFormTargetFooter pageId="p1" />);
    await flush();
    assert({
      given: 'a canvas with no form target',
      should: 'render no wired-form line',
      actual: container.textContent,
      expected: '',
    });
  });

  test('ignores archived targets', async () => {
    responses.byUrl.set('/api/pages/p1/form-target', { formTargets: [{ sheetPageId: 's1', status: 'archived' }] });
    const container = mount(<CanvasFormTargetFooter pageId="p1" />);
    await flush();
    assert({
      given: 'a canvas whose only form target is archived',
      should: 'render no wired-form line',
      actual: container.textContent,
      expected: '',
    });
  });
});
