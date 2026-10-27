/**
 * The gallery is what makes a batch of photos read as one message, so these
 * cover the shapes it has to survive: several images, a mix of images and
 * files, a message written before attachment rows existed, and one whose file
 * was hard-deleted out from under it.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="lightbox">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

import { MessageAttachments } from '../MessageAttachments';
import type { MessageWithAttachment } from '@/lib/attachment-utils';

const assert = ({ given, should, actual, expected }: {
  given: string; should: string; actual: unknown; expected: unknown;
}) => expect(actual, `Given ${given}, should ${should}`).toEqual(expected);

const meta = (name: string, mimeType = 'image/png') => ({
  originalName: name,
  size: 1,
  mimeType,
  contentHash: 'a'.repeat(64),
});

const imageMessage = (count: number): MessageWithAttachment => ({
  attachments: Array.from({ length: count }, (_, i) => ({
    id: `att-${i}`,
    fileId: `file-${i}`,
    attachmentMeta: meta(`photo-${i}.png`),
    position: i,
  })),
});

const srcs = () =>
  screen.getAllByRole('img').map((img) => img.getAttribute('src'));

describe('MessageAttachments', () => {
  it('renders one tile per image in a batch', () => {
    render(<MessageAttachments message={imageMessage(3)} />);
    assert({
      given: 'a message carrying three photos',
      should: 'render all three in one gallery, not just the first',
      actual: srcs(),
      expected: ['/api/files/file-0/view', '/api/files/file-1/view', '/api/files/file-2/view'],
    });
  });

  it('renders a pre-migration message from its legacy columns', () => {
    render(
      <MessageAttachments message={{ fileId: 'legacy-1', attachmentMeta: meta('old.png') }} />,
    );
    assert({
      given: 'a message written before messages had attachment rows',
      should: 'render through the same path as a modern one',
      actual: srcs(),
      expected: ['/api/files/legacy-1/view'],
    });
  });

  it('renders nothing for a text-only message', () => {
    const { container } = render(
      <MessageAttachments message={{ fileId: null, attachmentMeta: null, attachments: [] }} />,
    );
    assert({
      given: 'a message with no attachments',
      should: 'render no attachment area at all',
      actual: container.innerHTML,
      expected: '',
    });
  });

  it('drops a hard-deleted file and keeps its siblings', () => {
    const message: MessageWithAttachment = {
      attachments: [
        { id: 'a-1', fileId: 'file-1', attachmentMeta: meta('kept.png'), position: 0 },
        // ON DELETE SET NULL leaves the row and its meta, minus the file.
        { id: 'a-2', fileId: null, attachmentMeta: meta('gone.png'), position: 1 },
        { id: 'a-3', fileId: 'file-3', attachmentMeta: meta('also-kept.png'), position: 2 },
      ],
    };
    render(<MessageAttachments message={message} />);
    assert({
      given: 'a gallery where one file was hard-deleted',
      should: 'render the two survivors and no broken tile for the third',
      actual: srcs(),
      expected: ['/api/files/file-1/view', '/api/files/file-3/view'],
    });
  });

  it('orders tiles by position, not by the order the rows arrived', () => {
    const message: MessageWithAttachment = {
      attachments: [
        { id: 'a-3', fileId: 'file-c', attachmentMeta: meta('c.png'), position: 2 },
        { id: 'a-1', fileId: 'file-a', attachmentMeta: meta('a.png'), position: 0 },
        { id: 'a-2', fileId: 'file-b', attachmentMeta: meta('b.png'), position: 1 },
      ],
    };
    render(<MessageAttachments message={message} />);
    assert({
      given: 'rows returned out of order, as a query with no ORDER BY may do',
      should: 'lay them out in the order the sender attached them',
      actual: srcs(),
      expected: ['/api/files/file-a/view', '/api/files/file-b/view', '/api/files/file-c/view'],
    });
  });

  it('keeps images and non-images in one message', () => {
    const message: MessageWithAttachment = {
      attachments: [
        { id: 'a-1', fileId: 'file-img', attachmentMeta: meta('shot.png'), position: 0 },
        { id: 'a-2', fileId: 'file-pdf', attachmentMeta: meta('doc.pdf', 'application/pdf'), position: 1 },
      ],
    };
    render(<MessageAttachments message={message} />);
    assert({
      given: 'a message carrying one photo and one PDF',
      should: 'put the photo in the grid and still surface the file as a download',
      actual: {
        images: srcs(),
        pdfLink: screen
          .getAllByRole('link')
          .some((a) => a.getAttribute('href')?.includes('/api/files/file-pdf/download')),
      },
      expected: { images: ['/api/files/file-img/view'], pdfLink: true },
    });
  });

  it('opens the lightbox on the tile that was clicked', async () => {
    const user = userEvent.setup();
    render(<MessageAttachments message={imageMessage(3)} />);

    // The grid tiles are the buttons; the lightbox is closed until one is hit.
    expect(screen.queryByTestId('lightbox')).toBeNull();
    await user.click(screen.getAllByRole('button')[1]);

    assert({
      given: 'a click on the second of three photos',
      should: 'open the viewer on that photo, not on the first',
      actual: screen.getByText('2 / 3').textContent,
      expected: '2 / 3',
    });
  });

  it('pages forward through the gallery and wraps at the end', async () => {
    const user = userEvent.setup();
    render(<MessageAttachments message={imageMessage(3)} />);
    await user.click(screen.getAllByRole('button')[2]);

    const next = screen.getByLabelText('Next image');
    await user.click(next);

    assert({
      given: 'the viewer open on the last photo and Next pressed',
      should: 'wrap round to the first rather than dead-ending',
      actual: screen.getByText('1 / 3').textContent,
      expected: '1 / 3',
    });
  });

  it('keeps the same img elements when the send confirms', () => {
    // The optimistic rows the composer builds carry no attachment id; the
    // server echo replaces them with rows that do. Keying tiles on that id
    // would change every key at that moment, remounting every <img> — a
    // visible reload flash on the sender's own batch, and the failed-image set
    // (keyed the same way) would reset with it.
    const optimistic: MessageWithAttachment = {
      attachments: [
        { fileId: 'file-0', attachmentMeta: meta('photo-0.png'), position: 0 },
        { fileId: 'file-1', attachmentMeta: meta('photo-1.png'), position: 1 },
      ],
    };
    const { rerender } = render(<MessageAttachments message={optimistic} />);
    const before = screen.getAllByRole('img');

    rerender(<MessageAttachments message={imageMessage(2)} />);

    assert({
      given: 'the confirmed message replacing the optimistic one, same files in the same order',
      should: 'reuse the very same DOM nodes rather than remounting the gallery',
      actual: screen.getAllByRole('img').map((img, i) => img === before[i]),
      expected: [true, true],
    });
  });

  it('stays on the same photo when the message updates under an open viewer', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<MessageAttachments message={imageMessage(3)} />);
    await user.click(screen.getAllByRole('button')[2]);
    expect(screen.getByText('3 / 3')).toBeTruthy();

    // The first photo's file is hard-deleted, so its tile drops out of the
    // list. Holding the open image by index would silently show a different
    // photo; holding it by identity keeps the one the user opened.
    rerender(
      <MessageAttachments
        message={{
          attachments: [
            { id: 'att-1', fileId: 'file-1', attachmentMeta: meta('photo-1.png'), position: 1 },
            { id: 'att-2', fileId: 'file-2', attachmentMeta: meta('photo-2.png'), position: 2 },
          ],
        }}
      />,
    );

    // An index-based viewer would be pointing past the end of the list here:
    // the dialog closes and this counter does not exist at all.
    assert({
      given: 'a tile disappearing while the viewer is open on the last photo',
      should: 'still be showing that same photo, now second of two',
      actual: screen.getByText('2 / 2').textContent,
      expected: '2 / 2',
    });
  });

  it('offers no paging controls for a single image', async () => {
    const user = userEvent.setup();
    render(<MessageAttachments message={imageMessage(1)} />);
    await user.click(screen.getAllByRole('button')[0]);

    assert({
      given: 'a lone photo',
      should: 'open the viewer with no prev/next chrome',
      actual: {
        open: screen.queryByTestId('lightbox') !== null,
        next: screen.queryByLabelText('Next image'),
      },
      expected: { open: true, next: null },
    });
  });
});
