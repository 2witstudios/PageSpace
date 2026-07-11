import { describe, test, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { assert } from '@/stores/__tests__/riteway';

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
}));

// Monaco is next/dynamic(ssr:false); stub it so the pane's fetch/state logic and
// the props it hands the editor (value, language, readOnly) are what's asserted.
vi.mock('@/components/editors/MonacoEditor', () => ({
  default: ({ value, language, readOnly }: { value: string; language?: string; readOnly?: boolean }) => (
    <div data-testid="monaco" data-language={language} data-readonly={String(readOnly)}>
      {value}
    </div>
  ),
}));

import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import CodeFilePane from './CodeFilePane';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const renderPane = (path = 'src/index.ts') =>
  render(<CodeFilePane machineId="machine-1" projectName="repo" branchName="main" path={path} />);

const requested = (call: unknown[], param: string): string | null =>
  new URL(String(call[0]), 'http://test').searchParams.get(param);

describe('CodeFilePane', () => {
  beforeEach(() => vi.clearAllMocks());

  test('reads the selected file and shows it read-only with a detected language', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(jsonResponse({ content: 'export const x = 1;', encoding: 'utf8', truncated: false }));
    renderPane('src/index.ts');

    const monaco = await waitFor(() => screen.getByTestId('monaco'));

    assert({
      given: 'a .ts file whose read succeeds',
      should: 'render its content read-only in Monaco with typescript highlighting',
      actual: {
        value: monaco.textContent,
        language: monaco.getAttribute('data-language'),
        readOnly: monaco.getAttribute('data-readonly'),
      },
      expected: { value: 'export const x = 1;', language: 'typescript', readOnly: 'true' },
    });
  });

  test('requests mode=read with the checkout-relative path', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(jsonResponse({ content: '', encoding: 'utf8', truncated: false }));
    renderPane('src/index.ts');

    await waitFor(() => screen.getByTestId('monaco'));
    const call = vi.mocked(fetchWithAuth).mock.calls[0];

    assert({
      given: 'a mounted pane for a selected file',
      should: 'call the files route in read mode for that exact path',
      actual: { mode: requested(call, 'mode'), path: requested(call, 'path') },
      expected: { mode: 'read', path: 'src/index.ts' },
    });
  });

  test('flags a truncated read so a partial view is not mistaken for the whole file', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(jsonResponse({ content: 'partial', encoding: 'utf8', truncated: true }));
    renderPane();

    await waitFor(() => screen.getByTestId('monaco'));

    assert({
      given: 'a read the route capped at its size limit',
      should: 'surface a Truncated banner alongside the content',
      actual: screen.queryByText('Truncated') !== null,
      expected: true,
    });
  });

  test('surfaces the API error message and retries on demand', async () => {
    vi.mocked(fetchWithAuth)
      .mockResolvedValueOnce(jsonResponse({ error: 'File not found', reason: 'enoent' }, 404))
      .mockResolvedValueOnce(jsonResponse({ content: 'recovered', encoding: 'utf8', truncated: false }));
    renderPane();

    await waitFor(() => screen.getByText('File not found'));
    await userEvent.click(screen.getByText('Retry'));
    const monaco = await waitFor(() => screen.getByTestId('monaco'));

    assert({
      given: 'a failed read retried via its Retry button',
      should: "show the API's error first, then the content after a successful refetch",
      actual: { value: monaco.textContent, fetches: vi.mocked(fetchWithAuth).mock.calls.length },
      expected: { value: 'recovered', fetches: 2 },
    });
  });

  test('changing the selected file refetches for the new path', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(jsonResponse({ content: 'x', encoding: 'utf8', truncated: false }));
    const { rerender } = renderPane('a.ts');
    await waitFor(() => screen.getByTestId('monaco'));

    rerender(<CodeFilePane machineId="machine-1" projectName="repo" branchName="main" path="b.ts" />);
    await waitFor(() => {
      const lastPath = requested(vi.mocked(fetchWithAuth).mock.calls.at(-1) ?? [], 'path');
      if (lastPath !== 'b.ts') throw new Error('new path not fetched yet');
    });

    assert({
      given: 'the path prop changed to another file',
      should: 'issue a second read for the new path',
      actual: {
        fetches: vi.mocked(fetchWithAuth).mock.calls.length,
        lastPath: requested(vi.mocked(fetchWithAuth).mock.calls.at(-1) ?? [], 'path'),
      },
      expected: { fetches: 2, lastPath: 'b.ts' },
    });
  });

  test('a 200 response without string content is surfaced as an error, not a crash', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(jsonResponse({ unexpected: true }));
    renderPane();

    const error = await waitFor(() => screen.getByText('Malformed file read response'));

    assert({
      given: 'a successful response whose body has no string content',
      should: 'render a meaningful error instead of throwing',
      actual: error.textContent,
      expected: 'Malformed file read response',
    });
  });
});
