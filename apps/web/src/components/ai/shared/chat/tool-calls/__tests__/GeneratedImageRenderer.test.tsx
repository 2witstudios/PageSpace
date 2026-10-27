/**
 * GeneratedImageRenderer tests.
 *
 * Regression coverage for a real bug caught in review (PR #2019): a
 * generate_image call routed through the execute_tool wrapper (used by
 * search-mode/Global Assistant agents) can complete with an error-shaped
 * output — `{ error: string }` — that carries no `success: false` field
 * (see execute-tool.ts's safeParse-failure and permission-denied branches).
 * The renderer used to treat "no viewUrl yet" as the ONLY loading signal,
 * so a completed-but-errored call spun forever instead of showing the
 * error row already implemented below it.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { GeneratedImageRenderer, type GeneratedImageToolPart } from '../GeneratedImageRenderer';

describe('GeneratedImageRenderer', () => {
  it('shows a loading placeholder while no output has arrived yet', () => {
    const part: GeneratedImageToolPart = { state: 'input-available', input: { prompt: 'a red panda' } };
    const { container } = render(<GeneratedImageRenderer part={part} />);
    expect(container.querySelector('svg.animate-spin')).not.toBeNull();
  });

  it('shows the error row (not a spinner) for an execute_tool-style error output with no success field', () => {
    const part: GeneratedImageToolPart = {
      state: 'output-available',
      input: { prompt: 'a red panda' },
      output: { error: 'Invalid parameters for "generate_image". Call tool_search(...)' },
    };
    const { container, getByText } = render(<GeneratedImageRenderer part={part} />);
    expect(container.querySelector('svg.animate-spin')).toBeNull();
    expect(getByText(/Invalid parameters for "generate_image"/)).toBeTruthy();
  });

  it('shows the error row for an explicit success: false output', () => {
    const part: GeneratedImageToolPart = {
      state: 'output-available',
      output: { success: false, error: 'Insufficient credits to generate an image.' },
    };
    const { getByText } = render(<GeneratedImageRenderer part={part} />);
    expect(getByText('Insufficient credits to generate an image.')).toBeTruthy();
  });

  it('renders the image once viewUrl is present, with no loading spinner or error row', () => {
    const part: GeneratedImageToolPart = {
      state: 'output-available',
      output: { success: true, viewUrl: '/api/files/page-9/view', pageId: 'page-9', driveId: 'home-1' },
    };
    const { container } = render(<GeneratedImageRenderer part={part} />);
    expect(container.querySelector('svg.animate-spin')).toBeNull();
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe('/api/files/page-9/view');
  });
});
