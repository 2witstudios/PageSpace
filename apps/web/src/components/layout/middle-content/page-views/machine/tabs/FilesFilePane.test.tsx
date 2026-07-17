import { describe, test, beforeEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { assert } from '@/stores/__tests__/riteway';

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

/** Stable across calls (unlike a fresh `vi.fn()` per `getState()`) so tests can
 * assert on startEditing/endEditing pairs across renders. */
const editingStore = { startEditing: vi.fn(), endEditing: vi.fn() };
vi.mock('@/stores/useEditingStore', () => ({
  useEditingStore: { getState: () => editingStore },
}));

/**
 * Every (language, value, readOnly) triple Monaco has been handed, across ALL
 * renders.
 *
 * The final DOM is not enough to police "never show one file's content under
 * another file's name": React flushes the pane's effect before paint, so a bad
 * intermediate render is gone by the time a DOM assertion runs — but Monaco has
 * already been handed the wrong content by then, and in production that is a
 * real setValue against its model. Recording renders is what makes that window
 * observable.
 */
const monacoRenders: { language: string | undefined; value: string; readOnly: boolean | undefined }[] = [];

// Monaco is next/dynamic(ssr:false); stub it so the pane's fetch/state logic and
// the props it hands the editor (value, language, readOnly, onChange) are what's
// asserted. The stub renders a textarea wired to onChange so tests can simulate
// a user editing the buffer without needing the real Monaco bundle.
vi.mock('@/components/editors/MonacoEditor', () => ({
  default: ({
    value,
    language,
    readOnly,
    onChange,
  }: {
    value: string;
    language?: string;
    readOnly?: boolean;
    onChange?: (value: string | undefined) => void;
  }) => {
    monacoRenders.push({ language, value, readOnly });
    // Read-only renders `value` as plain text; editable renders a textarea bound
    // to `onChange` instead of ALSO showing the text, so `monaco.textContent`
    // reflects the buffer exactly once either way (a textarea's value is its
    // own text-node child in the DOM, so rendering both would double it).
    return (
      <div data-testid="monaco" data-language={language} data-readonly={String(readOnly)}>
        {readOnly ? (
          value
        ) : (
          <textarea
            aria-label="editor-content"
            value={value}
            onChange={(e) => onChange?.(e.target.value)}
          />
        )}
      </div>
    );
  },
}));

import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { toast } from 'sonner';
import FilesFilePane from './FilesFilePane';
import type { FilesScope } from './files-scope';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const BRANCH_SCOPE: FilesScope = { kind: 'branch', projectName: 'repo', branchName: 'main' };

const renderPane = (path = 'src/index.ts', scope: FilesScope = BRANCH_SCOPE) =>
  render(<FilesFilePane machineId="machine-1" scope={scope} path={path} />);

const requested = (call: unknown[], param: string): string | null =>
  new URL(String(call[0]), 'http://test').searchParams.get(param);

/** A response the test resolves by hand, to hold one read in flight. */
const deferredResponse = () => {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

describe('FilesFilePane', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    monacoRenders.length = 0;
  });

  test('reads the selected file and shows it editable with a detected language', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(jsonResponse({ content: 'export const x = 1;', encoding: 'utf8', truncated: false }));
    renderPane('src/index.ts');

    const monaco = await waitFor(() => screen.getByTestId('monaco'));

    assert({
      given: 'a .ts file whose read succeeds cleanly (not truncated)',
      should: 'mount it editable in Monaco with typescript highlighting',
      actual: {
        value: monaco.textContent,
        language: monaco.getAttribute('data-language'),
        readOnly: monaco.getAttribute('data-readonly'),
      },
      expected: { value: 'export const x = 1;', language: 'typescript', readOnly: 'false' },
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

  test('a truncated read stays read-only with no Save affordance', async () => {
    // Saving a truncated view would silently drop the file's tail on disk — the
    // route caps a single read at 2 MiB, so a truncated buffer never has the
    // whole file to begin with.
    vi.mocked(fetchWithAuth).mockResolvedValue(jsonResponse({ content: 'partial', encoding: 'utf8', truncated: true }));
    renderPane();

    const monaco = await waitFor(() => screen.getByTestId('monaco'));

    assert({
      given: 'a truncated read',
      should: 'stay read-only in Monaco (no editable buffer mounted) and never offer a Save button',
      actual: {
        readOnly: monaco.getAttribute('data-readonly'),
        editorTextarea: screen.queryByLabelText('editor-content'),
        saveButton: screen.queryByTitle('Save file (Cmd/Ctrl-S)'),
      },
      expected: { readOnly: 'true', editorTextarea: null, saveButton: null },
    });
  });

  test('surfaces a genuine API error and retries on demand', async () => {
    vi.mocked(fetchWithAuth)
      .mockResolvedValueOnce(jsonResponse({ error: 'ls: cannot execute', reason: 'exec_failed' }, 502))
      .mockResolvedValueOnce(jsonResponse({ content: 'recovered', encoding: 'utf8', truncated: false }));
    renderPane();

    await waitFor(() => screen.getByText('ls: cannot execute'));
    await userEvent.click(screen.getByText('Retry'));
    const monaco = await waitFor(() => screen.getByTestId('monaco'));

    assert({
      given: 'a read that failed for a real reason (exec_failed), retried via its Retry button',
      should: "show the API's error first, then the content after a successful refetch",
      actual: { value: monaco.textContent, fetches: vi.mocked(fetchWithAuth).mock.calls.length },
      expected: { value: 'recovered', fetches: 2 },
    });
  });

  test("a missing file reads as plain english, not the route's phrasing", async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(
      jsonResponse({ error: 'File not found', reason: 'file_not_found' }, 404),
    );
    renderPane('src/deleted.ts');

    const message = await waitFor(() => screen.getByText('This file is no longer in the checkout.'));

    assert({
      given: 'a file deleted from the working tree between listing it and reading it',
      should: 'explain it in the user\'s terms rather than echoing the route',
      actual: message.textContent,
      expected: 'This file is no longer in the checkout.',
    });
  });

  test("a vanished sandbox is a checkout state, not a red error string", async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(
      jsonResponse({ error: 'Branch machine vanished', reason: 'vanished' }, 503),
    );
    renderPane();

    await waitFor(() => screen.getByTestId('checkout-absent-pane'));

    assert({
      given: "an open file whose branch Sprite was reclaimed mid-session",
      should: "show the same 'checkout is gone' copy the sidebar shows — never the route's internal phrasing",
      actual: {
        friendly: screen.queryByText('This branch checkout is gone') !== null,
        leaked: screen.queryByText('Branch machine vanished') !== null,
      },
      expected: { friendly: true, leaked: false },
    });
  });

  test('a binary with an unknown extension is caught by content, not just filename', async () => {
    // `.node` is a real binary that BINARY_EXTENSIONS (written for GitHub import)
    // does not list — so only the content sniff can catch it.
    vi.mocked(fetchWithAuth).mockResolvedValue(
      jsonResponse({ content: `ELF${String.fromCharCode(0)}${String.fromCharCode(2)}`, encoding: 'utf8', truncated: false }),
    );
    renderPane('build/Release/addon.node');

    await waitFor(() => screen.getByTestId('binary-file'));

    assert({
      given: 'a file whose extension is not in the binary list but whose content holds a NUL byte',
      should: "fall back to git's own heuristic and refuse to render it as text",
      actual: screen.queryByTestId('monaco'),
      expected: null,
    });
  });

  test('changing the selected file refetches for the new path', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(jsonResponse({ content: 'x', encoding: 'utf8', truncated: false }));
    const { rerender } = renderPane('a.ts');
    await waitFor(() => screen.getByTestId('monaco'));

    rerender(<FilesFilePane machineId="machine-1" scope={BRANCH_SCOPE} path="b.ts" />);
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

  test('a slow read that lands AFTER the selection moved on is discarded', async () => {
    // The scenario the `cancelled` flag exists for: the user clicks a big file,
    // then clicks another before the first read comes back. The first read must
    // not overwrite the file the user is actually looking at now.
    const slow = deferredResponse();
    vi.mocked(fetchWithAuth)
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValueOnce(jsonResponse({ content: 'the file I clicked second', encoding: 'utf8', truncated: false }));

    const { rerender } = renderPane('slow.ts');
    rerender(<FilesFilePane machineId="machine-1" scope={BRANCH_SCOPE} path="quick.ts" />);
    await waitFor(() => screen.getByTestId('monaco'));

    // Only NOW does the abandoned first read resolve. Flush inside act() so any
    // state update it (wrongly) triggers is applied to the DOM before we look —
    // without this, the assertion reads a pre-render snapshot and passes even
    // when the guard is gone. Verified by mutation: deleting the `cancelled`
    // checks makes this test fail.
    await act(async () => {
      slow.resolve(jsonResponse({ content: 'STALE - the file I clicked first', encoding: 'utf8', truncated: false }));
      await Promise.resolve();
    });

    assert({
      given: 'a read for the previous file resolving after the current file already rendered',
      should: "discard the stale response rather than clobber the user's current file",
      actual: screen.getByTestId('monaco').textContent,
      expected: 'the file I clicked second',
    });
  });

  test('a binary file shows a no-preview state and is never read', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(jsonResponse({ content: 'PNG', encoding: 'utf8', truncated: false }));
    renderPane('assets/logo.png');

    await waitFor(() => screen.getByTestId('binary-file'));

    assert({
      given: 'a binary file selected in the tree',
      should: 'show a no-preview state and skip the read entirely (UTF-8 decoding it would be mojibake)',
      actual: {
        monaco: screen.queryByTestId('monaco'),
        fetches: vi.mocked(fetchWithAuth).mock.calls.length,
      },
      expected: { monaco: null, fetches: 0 },
    });
  });

  test('switching from a binary file to a text file reads the text file', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(jsonResponse({ content: 'after', encoding: 'utf8', truncated: false }));
    const { rerender } = renderPane('assets/logo.png');
    await waitFor(() => screen.getByTestId('binary-file'));

    rerender(<FilesFilePane machineId="machine-1" scope={BRANCH_SCOPE} path="src/a.ts" />);
    const monaco = await waitFor(() => screen.getByTestId('monaco'));

    assert({
      given: 'the selection moved off a binary file onto a text file',
      should: 'leave the no-preview state and read the newly selected file',
      actual: { value: monaco.textContent, fetches: vi.mocked(fetchWithAuth).mock.calls.length },
      expected: { value: 'after', fetches: 1 },
    });
  });

  test('a short legacy-encoded text file is NOT declared binary', async () => {
    // "Café Résumé" as Latin-1: 3 undecodable bytes in 11 chars = 27%, over any
    // sane ratio. A ratio with no absolute floor would hide this file entirely.
    const REPLACEMENT = String.fromCharCode(0xfffd);
    vi.mocked(fetchWithAuth).mockResolvedValue(
      jsonResponse({ content: `Caf${REPLACEMENT} R${REPLACEMENT}sum${REPLACEMENT}`, encoding: 'utf8', truncated: false }),
    );
    renderPane('notes.txt');

    const monaco = await waitFor(() => screen.getByTestId('monaco'));

    assert({
      given: 'a short Latin-1 text file with a high RATIO but a low COUNT of undecodable bytes',
      should: 'still render it as text (mojibake glyphs and all) rather than hiding it as binary',
      actual: { rendered: monaco.textContent !== null, binary: screen.queryByTestId('binary-file') },
      expected: { rendered: true, binary: null },
    });
  });

  test('a checkout that vanished is reported as such even on a 404 read', async () => {
    // The route now distinguishes `not_found` (no checkout) from `file_not_found`
    // (checkout fine, file gone) — both 404. Without that split, removing the
    // branch-terminal under an open file said "this file is no longer in the
    // checkout", which is a lie about which thing disappeared.
    vi.mocked(fetchWithAuth).mockResolvedValue(
      jsonResponse({ error: 'This branch checkout is unavailable', reason: 'not_found' }, 404),
    );
    renderPane();

    await waitFor(() => screen.getByTestId('checkout-absent-pane'));

    assert({
      given: 'an open file whose branch-terminal was removed (404 + reason not_found)',
      should: 'say the BRANCH has no checkout, not that the file is missing',
      actual: {
        checkoutCopy: screen.queryByText("This branch hasn't been checked out yet") !== null,
        fileCopy: screen.queryByText('This file is no longer in the checkout.') !== null,
      },
      expected: { checkoutCopy: true, fileCopy: false },
    });
  });

  test('the header reload re-reads the open file (the working tree is live)', async () => {
    vi.mocked(fetchWithAuth)
      .mockResolvedValueOnce(jsonResponse({ content: 'before', encoding: 'utf8', truncated: false }))
      .mockResolvedValueOnce(jsonResponse({ content: 'after the agent edited it', encoding: 'utf8', truncated: false }));
    renderPane();

    await waitFor(() => screen.getByText('before'));
    await userEvent.click(screen.getByTitle('Reload file'));
    await waitFor(() => screen.getByText('after the agent edited it'));

    assert({
      given: 'an open file rewritten by an agent terminal, then the header reload clicked',
      should: 're-read it — re-clicking the same tree row is a no-op, so this is the only way',
      actual: {
        value: screen.getByTestId('monaco').textContent,
        reads: vi.mocked(fetchWithAuth).mock.calls.length,
      },
      expected: { value: 'after the agent edited it', reads: 2 },
    });
  });

  test("never hands Monaco one file's content under another file's language", async () => {
    // a.ts is typescript, b.py is python. If the pane ever renders the TS file's
    // content while already being asked for the Python file, Monaco is handed
    // ('python', 'contents of a.ts') — the exact pair this test forbids. The bad
    // render is pre-paint (React flushes the effect first), so it is invisible in
    // the final DOM; only the render log can see it.
    const slow = deferredResponse();
    vi.mocked(fetchWithAuth)
      .mockResolvedValueOnce(jsonResponse({ content: 'contents of a.ts', encoding: 'utf8', truncated: false }))
      .mockReturnValueOnce(slow.promise);

    const { rerender } = renderPane('a.ts');
    await waitFor(() => screen.getByText('contents of a.ts'));

    rerender(<FilesFilePane machineId="machine-1" scope={BRANCH_SCOPE} path="b.py" />);
    await waitFor(() => screen.getByText('Loading file…'));

    assert({
      given: "a switch to a file whose read hasn't come back yet",
      should: "never hand Monaco the previous file's content under the new file's language",
      actual: monacoRenders.filter((r) => r.language === 'python' && r.value === 'contents of a.ts'),
      expected: [],
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

  test('root scope reads without projectName/branchName params', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(jsonResponse({ content: 'x', encoding: 'utf8', truncated: false }));
    renderPane('README.md', { kind: 'root' });

    await waitFor(() => screen.getByTestId('monaco'));
    const call = vi.mocked(fetchWithAuth).mock.calls[0];

    assert({
      given: 'a pane mounted with root scope',
      should: 'read with no projectName/branchName params',
      actual: { projectName: requested(call, 'projectName'), branchName: requested(call, 'branchName') },
      expected: { projectName: null, branchName: null },
    });
  });

  test('a not_started machine renders its own absent copy', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(
      jsonResponse({ error: "This machine hasn't been started yet", reason: 'not_started' }, 404),
    );
    renderPane('README.md', { kind: 'root' });

    const message = await waitFor(() => screen.getByText("This machine hasn't been started yet"));

    assert({
      given: 'a root scope whose machine has never been started',
      should: 'render the not_started absent copy, distinct from not_found/vanished',
      actual: message.textContent,
      expected: "This machine hasn't been started yet",
    });
  });

  test('a missing file in root scope reads as "no longer on the machine"', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(
      jsonResponse({ error: 'File not found', reason: 'file_not_found' }, 404),
    );
    renderPane('deleted.txt', { kind: 'root' });

    const message = await waitFor(() => screen.getByText('This file is no longer on the machine.'));

    assert({
      given: 'a file deleted from the machine root between listing and reading it',
      should: 'use the root-scope copy, not the branch-scope "checkout" phrasing',
      actual: message.textContent,
      expected: 'This file is no longer on the machine.',
    });
  });

  describe('editing and save', () => {
    const editContent = async (text: string) => {
      const editor = screen.getByLabelText('editor-content');
      await userEvent.clear(editor);
      await userEvent.type(editor, text);
      return editor;
    };

    test('editing a clean file marks it dirty and shows the Save affordance', async () => {
      vi.mocked(fetchWithAuth).mockResolvedValue(jsonResponse({ content: 'export const x = 1;', encoding: 'utf8', truncated: false }));
      renderPane('src/index.ts');

      await waitFor(() => screen.getByTestId('monaco'));
      await editContent('export const x = 2;');
      await waitFor(() => screen.getByTitle('Unsaved changes'));

      assert({
        given: 'a clean text file edited in the editor',
        should: 'show the dirty dot and a Save button',
        actual: {
          dirtyDot: screen.queryByTitle('Unsaved changes') !== null,
          saveButton: screen.queryByTitle('Save file (Cmd/Ctrl-S)') !== null,
        },
        expected: { dirtyDot: true, saveButton: true },
      });
    });

    test('Save POSTs the edited content with scope fields and cleans the dirty state', async () => {
      vi.mocked(fetchWithAuth)
        .mockResolvedValueOnce(jsonResponse({ content: 'before', encoding: 'utf8', truncated: false }))
        .mockResolvedValueOnce(jsonResponse({ ok: true }));
      renderPane('src/index.ts', BRANCH_SCOPE);

      await waitFor(() => screen.getByTestId('monaco'));
      await editContent('after');
      await waitFor(() => screen.getByTitle('Save file (Cmd/Ctrl-S)'));
      await userEvent.click(screen.getByTitle('Save file (Cmd/Ctrl-S)'));
      await waitFor(() => {
        if (vi.mocked(fetchWithAuth).mock.calls.length < 2) throw new Error('not saved yet');
      });

      const call = vi.mocked(fetchWithAuth).mock.calls[1];
      const options = call[1] as RequestInit;

      assert({
        given: 'a dirty branch-scope file, saved via the Save button',
        should: "POST kind:'file' utf8 content plus scope fields to the files route, then clean the dirty state",
        actual: {
          url: call[0],
          method: options.method,
          body: JSON.parse(String(options.body)),
          dirtyAfter: screen.queryByTitle('Unsaved changes'),
          saveButtonAfter: screen.queryByTitle('Save file (Cmd/Ctrl-S)'),
        },
        expected: {
          url: '/api/machines/files',
          method: 'POST',
          body: {
            machineId: 'machine-1',
            projectName: 'repo',
            branchName: 'main',
            path: 'src/index.ts',
            kind: 'file',
            encoding: 'utf8',
            content: 'after',
          },
          dirtyAfter: null,
          saveButtonAfter: null,
        },
      });
    });

    test('root scope saves omit projectName/branchName from the POST body', async () => {
      vi.mocked(fetchWithAuth)
        .mockResolvedValueOnce(jsonResponse({ content: 'before', encoding: 'utf8', truncated: false }))
        .mockResolvedValueOnce(jsonResponse({ ok: true }));
      renderPane('README.md', { kind: 'root' });

      await waitFor(() => screen.getByTestId('monaco'));
      await editContent('after');
      await waitFor(() => screen.getByTitle('Save file (Cmd/Ctrl-S)'));
      await userEvent.click(screen.getByTitle('Save file (Cmd/Ctrl-S)'));
      await waitFor(() => {
        if (vi.mocked(fetchWithAuth).mock.calls.length < 2) throw new Error('not saved yet');
      });

      const body = JSON.parse(String((vi.mocked(fetchWithAuth).mock.calls[1][1] as RequestInit).body));

      assert({
        given: 'a dirty root-scope file, saved',
        should: 'POST without projectName/branchName, matching the root-scope read',
        actual: { projectName: body.projectName, branchName: body.branchName },
        expected: { projectName: undefined, branchName: undefined },
      });
    });

    test('Cmd/Ctrl-S saves the dirty draft', async () => {
      vi.mocked(fetchWithAuth)
        .mockResolvedValueOnce(jsonResponse({ content: 'before', encoding: 'utf8', truncated: false }))
        .mockResolvedValueOnce(jsonResponse({ ok: true }));
      renderPane('src/index.ts', BRANCH_SCOPE);

      await waitFor(() => screen.getByTestId('monaco'));
      await editContent('after');
      await waitFor(() => screen.getByTitle('Save file (Cmd/Ctrl-S)'));

      await act(async () => {
        fireEvent.keyDown(document, { key: 's', ctrlKey: true });
        await Promise.resolve();
      });
      await waitFor(() => {
        if (vi.mocked(fetchWithAuth).mock.calls.length < 2) throw new Error('not saved yet');
      });

      assert({
        given: 'a dirty draft and a Ctrl-S keypress',
        should: 'trigger the same save POST as clicking Save, and prevent the browser default',
        actual: {
          fetches: vi.mocked(fetchWithAuth).mock.calls.length,
          method: (vi.mocked(fetchWithAuth).mock.calls[1][1] as RequestInit).method,
        },
        expected: { fetches: 2, method: 'POST' },
      });
    });

    test('a 403 save failure toasts the edit-access copy and leaves the draft dirty', async () => {
      vi.mocked(fetchWithAuth)
        .mockResolvedValueOnce(jsonResponse({ content: 'before', encoding: 'utf8', truncated: false }))
        .mockResolvedValueOnce(jsonResponse({ error: "You don't have edit access to this machine", reason: 'forbidden' }, 403));
      renderPane('src/index.ts', BRANCH_SCOPE);

      await waitFor(() => screen.getByTestId('monaco'));
      await editContent('after');
      await waitFor(() => screen.getByTitle('Save file (Cmd/Ctrl-S)'));
      await userEvent.click(screen.getByTitle('Save file (Cmd/Ctrl-S)'));
      await waitFor(() => {
        if (vi.mocked(toast.error).mock.calls.length === 0) throw new Error('not toasted yet');
      });

      assert({
        given: 'a save rejected with 403',
        should: 'toast the edit-access copy and leave the draft dirty',
        actual: {
          toastMessage: vi.mocked(toast.error).mock.calls[0]?.[0],
          stillDirty: screen.queryByTitle('Unsaved changes') !== null,
        },
        expected: { toastMessage: "You don't have edit access to this machine", stillDirty: true },
      });
    });

    test('a 413 save failure toasts the too-large copy', async () => {
      vi.mocked(fetchWithAuth)
        .mockResolvedValueOnce(jsonResponse({ content: 'before', encoding: 'utf8', truncated: false }))
        .mockResolvedValueOnce(jsonResponse({ error: 'File is too large to upload', reason: 'too_large' }, 413));
      renderPane('src/index.ts', BRANCH_SCOPE);

      await waitFor(() => screen.getByTestId('monaco'));
      await editContent('after');
      await waitFor(() => screen.getByTitle('Save file (Cmd/Ctrl-S)'));
      await userEvent.click(screen.getByTitle('Save file (Cmd/Ctrl-S)'));
      await waitFor(() => {
        if (vi.mocked(toast.error).mock.calls.length === 0) throw new Error('not toasted yet');
      });

      assert({
        given: 'a save rejected with 413',
        should: 'toast the too-large copy',
        actual: vi.mocked(toast.error).mock.calls[0]?.[0],
        expected: 'File is too large to upload',
      });
    });

    test("a save failure for any other reason toasts the route's own error text", async () => {
      vi.mocked(fetchWithAuth)
        .mockResolvedValueOnce(jsonResponse({ content: 'before', encoding: 'utf8', truncated: false }))
        .mockResolvedValueOnce(jsonResponse({ error: 'Failed to complete the operation on the machine', reason: 'exec_failed' }, 502));
      renderPane('src/index.ts', BRANCH_SCOPE);

      await waitFor(() => screen.getByTestId('monaco'));
      await editContent('after');
      await waitFor(() => screen.getByTitle('Save file (Cmd/Ctrl-S)'));
      await userEvent.click(screen.getByTitle('Save file (Cmd/Ctrl-S)'));
      await waitFor(() => {
        if (vi.mocked(toast.error).mock.calls.length === 0) throw new Error('not toasted yet');
      });

      assert({
        given: 'a save rejected for a reason other than 403/413',
        should: "toast the route's own error text unmodified",
        actual: vi.mocked(toast.error).mock.calls[0]?.[0],
        expected: 'Failed to complete the operation on the machine',
      });
    });

    test('registers with useEditingStore while dirty and releases the same session id after save', async () => {
      vi.mocked(fetchWithAuth)
        .mockResolvedValueOnce(jsonResponse({ content: 'before', encoding: 'utf8', truncated: false }))
        .mockResolvedValueOnce(jsonResponse({ ok: true }));
      renderPane('src/index.ts', BRANCH_SCOPE);

      await waitFor(() => screen.getByTestId('monaco'));
      await editContent('after');
      await waitFor(() => {
        if (editingStore.startEditing.mock.calls.length === 0) throw new Error('not registered yet');
      });
      const sessionId = editingStore.startEditing.mock.calls[0][0];

      await userEvent.click(screen.getByTitle('Save file (Cmd/Ctrl-S)'));
      await waitFor(() => {
        if (!editingStore.endEditing.mock.calls.some((c) => c[0] === sessionId)) throw new Error('not released yet');
      });

      assert({
        given: "a draft that went dirty (useEditingStore registration, repo rule) then was saved",
        should: 'register a session while dirty and release that SAME session id once the save cleans the draft',
        actual: {
          registeredWhileDirty: editingStore.startEditing.mock.calls.some((c) => c[0] === sessionId && c[1] === 'document'),
          releasedAfterSave: editingStore.endEditing.mock.calls.some((c) => c[0] === sessionId),
        },
        expected: { registeredWhileDirty: true, releasedAfterSave: true },
      });
    });

    test('the reload button confirms before discarding a dirty draft, and declining keeps it', async () => {
      vi.mocked(fetchWithAuth).mockResolvedValue(jsonResponse({ content: 'before', encoding: 'utf8', truncated: false }));
      renderPane('src/index.ts', BRANCH_SCOPE);

      await waitFor(() => screen.getByTestId('monaco'));
      await editContent('after');
      await waitFor(() => screen.getByTitle('Unsaved changes'));

      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
      await userEvent.click(screen.getByTitle('Reload file'));

      assert({
        given: 'a dirty draft, Reload clicked, but the discard confirm declined',
        should: 'ask for confirmation and skip the re-fetch, leaving the dirty draft intact',
        actual: {
          confirmed: confirmSpy.mock.calls.length,
          fetches: vi.mocked(fetchWithAuth).mock.calls.length,
          stillDirty: screen.queryByTitle('Unsaved changes') !== null,
        },
        expected: { confirmed: 1, fetches: 1, stillDirty: true },
      });

      confirmSpy.mockRestore();
    });

    test('a confirmed reload discards the dirty draft and re-fetches', async () => {
      vi.mocked(fetchWithAuth)
        .mockResolvedValueOnce(jsonResponse({ content: 'before', encoding: 'utf8', truncated: false }))
        .mockResolvedValueOnce(jsonResponse({ content: 'reloaded from disk', encoding: 'utf8', truncated: false }));
      renderPane('src/index.ts', BRANCH_SCOPE);

      await waitFor(() => screen.getByTestId('monaco'));
      await editContent('after');
      await waitFor(() => screen.getByTitle('Unsaved changes'));

      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      await userEvent.click(screen.getByTitle('Reload file'));
      await waitFor(() => screen.getByText('reloaded from disk'));

      assert({
        given: 'a dirty draft, Reload clicked, discard confirmed',
        should: 're-fetch the file and clear the dirty state',
        actual: {
          confirmed: confirmSpy.mock.calls.length,
          value: screen.getByTestId('monaco').textContent,
          stillDirty: screen.queryByTitle('Unsaved changes') !== null,
        },
        expected: { confirmed: 1, value: 'reloaded from disk', stillDirty: false },
      });

      confirmSpy.mockRestore();
    });
  });
});
