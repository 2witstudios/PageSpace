/**
 * SPIKE (@adobe/data adoption evidence) — React 19 binding behaviour.
 *
 * Spike question: "should useObservableValues-based bindings render and hydrate
 * correctly (SSR story, strict mode double-render, RSC boundaries)?"
 *
 * NOTE for the epic's environment rail: the epic records that React render
 * tests fail in .pu worktrees (dual-React dispatcher null). That did NOT
 * reproduce for this file — `@adobe/data-react` resolves React from
 * `apps/web/node_modules`, the same copy the test runner uses, so client
 * render, StrictMode and hydration all execute here. The result is still to be
 * re-run on the main checkout before anyone leans on it (recorded on the spike
 * page), but the evidence below is real, not a typecheck stand-in.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { StrictMode, act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import { render, cleanup } from '@testing-library/react';
import { DatabaseProvider } from '@adobe/data-react';
import { chatStatePlugin } from '../chat-state-plugin';
import { createChatDatabase, type ChatDatabaseHandle } from '../createChatDatabase';
import { SpikeChatHarness } from '@/app/spike/adobe-data/SpikeChatHarness';

const CONVERSATION_ID = 'spike-conversation';

const tree = (handle: ChatDatabaseHandle) => (
  <DatabaseProvider plugin={chatStatePlugin} database={handle.db}>
    <SpikeChatHarness />
  </DatabaseProvider>
);

afterEach(cleanup);

describe('useObservableValues under server rendering', () => {
  it('given a server render, should not throw and should emit the skeleton branch', () => {
    const html = renderToStaticMarkup(tree(createChatDatabase()));

    expect(html).toContain('data-testid="spike-skeleton"');
    expect(html).not.toContain('data-testid="spike-messages"');
  });

  it('given StrictMode, the server render should be byte-identical to the non-strict one', () => {
    // Identical markup is what makes hydration mismatch structurally impossible:
    // `useObservable` seeds `undefined` and only subscribes in an effect, which
    // never runs on the server or in the first client render.
    const strict = renderToStaticMarkup(<StrictMode>{tree(createChatDatabase())}</StrictMode>);
    const loose = renderToStaticMarkup(tree(createChatDatabase()));

    expect(strict).toBe(loose);
  });
});

describe('useObservableValues under client rendering', () => {
  it('given a StrictMode mount, should render the observed values after effects run', () => {
    const handle = createChatDatabase();

    const view = render(<StrictMode>{tree(handle)}</StrictMode>);

    expect(view.getByTestId('spike-load-status').textContent).toBe('idle');
    expect(view.queryByTestId('spike-skeleton')).toBeNull();
  });

  it('given a committed transaction, should propagate to the rendered output', () => {
    const handle = createChatDatabase();
    const view = render(<StrictMode>{tree(handle)}</StrictMode>);

    act(() => {
      handle.db.transactions.seedConversation(CONVERSATION_ID);
    });

    expect(view.getByTestId('spike-load-status').textContent).toBe('loaded');
  });

  it('given streamed parts, should propagate each frame to the rendered stream list', () => {
    const handle = createChatDatabase();
    const view = render(<StrictMode>{tree(handle)}</StrictMode>);

    act(() => {
      handle.db.transactions.addStream({
        messageId: 's1',
        pageId: 'spike-page',
        conversationId: CONVERSATION_ID,
        triggeredBy: { userId: 'u1', displayName: 'Alice' },
        isOwn: true,
      });
    });
    act(() => {
      handle.db.transactions.appendPart({ messageId: 's1', part: { type: 'text', text: 'tok' } });
    });

    expect(view.getByTestId('spike-streams').textContent).toContain('s1: 1');
  });

  it('given an unmount, should stop applying updates', () => {
    const handle = createChatDatabase();
    const view = render(<StrictMode>{tree(handle)}</StrictMode>);
    view.unmount();

    // A transaction after unmount must not reach a detached component — React
    // would log "update on an unmounted component" via console.error.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    act(() => {
      handle.db.transactions.seedConversation(CONVERSATION_ID);
    });

    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe('hydration of a server-rendered harness', () => {
  it('given SSR markup hydrated on the client, should not report a hydration mismatch', () => {
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(tree(createChatDatabase()));
    document.body.appendChild(container);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const handle = createChatDatabase();
    let root: ReturnType<typeof hydrateRoot> | null = null;
    act(() => {
      root = hydrateRoot(container, tree(handle));
    });

    expect(consoleError).not.toHaveBeenCalled();
    // Post-hydration the effect has run, so the observed values replace the skeleton.
    expect(container.querySelector('[data-testid="spike-load-status"]')).not.toBeNull();

    consoleError.mockRestore();
    act(() => {
      root?.unmount();
    });
    container.remove();
  });
});
