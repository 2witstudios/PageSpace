/**
 * Guard: page content must never be writable through `pageRepository.update`.
 *
 * `update` issues a bare `db.update(pages).set(...)` with no revision
 * compare-and-swap, no version row, no activity entry and no broadcast. Any
 * caller that routed content through it would silently clobber whatever the
 * real write path (`applyPageMutation`) had established — and, once a Y.Doc
 * becomes the source of truth for DOCUMENT pages, would clobber that too.
 *
 * The compile-time half of this guard is the `@ts-expect-error` below: it fails
 * `bun run typecheck` the moment `content` is reintroduced to UpdatePageInput
 * (the directive becomes unused). The runtime half is `assertNoContentWrite`,
 * shared with `agentRepository.updateConfig` — the sibling seam that spreads an
 * equally widened input into the same bare `db.update(pages)`.
 */
import { describe, it, expect, vi } from 'vitest';
import type { UpdatePageInput } from '../page-repository';

vi.mock('@pagespace/db/db', () => ({ db: {} }));

describe('UpdatePageInput', () => {
  it('does not accept a content field', () => {
    const input: UpdatePageInput = {
      title: 'a new title',
      // @ts-expect-error content is not writable through the repository —
      // page content goes through applyPageMutation, which does the CAS.
      content: '<p>clobbered</p>',
    };

    expect(input.title).toBe('a new title');
  });
});

describe('the bare db.update(pages) seams', () => {
  it('pageRepository.update rejects a content key that arrives despite the type', async () => {
    const { pageRepository } = await import('../page-repository');

    await expect(
      pageRepository.update('page-1', { content: 'clobbered' } as UpdatePageInput)
    ).rejects.toThrow(/content/i);
  });

  it('agentRepository.updateConfig rejects one too — same widening, same hazard', async () => {
    const { agentRepository } = await import('../agent-repository');

    await expect(
      agentRepository.updateConfig('agent-1', { content: 'clobbered' } as never)
    ).rejects.toThrow(/content/i);
  });
});
