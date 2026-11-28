// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { fakeWeb } from '@/ui/test-support/fake-web';
import { click, mount, typeInto, unmountAll } from '@/ui/test-support/dom';
import { FeedbackDialog, FEEDBACK_ENDPOINT } from './FeedbackDialog';

const onClose = vi.fn();

const dialog = (client: ReturnType<typeof fakeWeb>['client']) =>
  mount(
    <ImagoSWRProvider client={client}>
      <FeedbackDialog isOpen={true} onClose={onClose} />
    </ImagoSWRProvider>,
  );

const find = (text: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === text);

const attach = (files: File[]) => {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error('no file input');
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

const image = (name: string) => new File(['x'], name, { type: 'image/png' });

beforeEach(() => {
  onClose.mockClear();
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  unmountAll();
  document.body.innerHTML = '';
});

describe('FeedbackDialog', () => {
  test('the form, and Submit disabled until there is feedback', () => {
    dialog(fakeWeb({}).client);

    assert({
      given: 'the dialog opened with no feedback typed',
      should: 'show the form copy and keep Submit Feedback disabled',
      actual: [
        document.querySelector('[role="dialog"]')?.textContent?.includes('Send Feedback'),
        document.body.textContent?.includes('121/2000') || document.body.textContent?.includes('0/2000'),
        document.body.textContent?.includes('Drag & drop images, paste from clipboard, or click to upload'),
        find('Submit Feedback')?.disabled,
      ],
      expected: [true, true, true, true],
    });
  });

  test('submitting posts the message, the screenshots and the context, then Thank you!', async () => {
    const web = fakeWeb({
      [`POST ${FEEDBACK_ENDPOINT}`]: () => Response.json({ success: true }),
    });
    dialog(web.client);
    const textarea = document.querySelector<HTMLTextAreaElement>('#feedback-message');
    if (textarea === null) throw new Error('no textarea');
    typeInto(textarea, '  The Share button moved  ');
    attach([image('a.png')]);
    click(find('Submit Feedback') as HTMLButtonElement);
    await vi.waitFor(() => {
      if (!document.body.textContent?.includes('Thank you!')) throw new Error('not submitted');
    });
    const [write] = web.writes();
    const body = write?.body as { message: string; attachments: { name: string; type: string; data: string }[]; context: Record<string, string> };

    assert({
      given: 'a message with surrounding spaces and one screenshot',
      should: 'post the trimmed message, the image as a data URL, and the page context',
      actual: [
        write?.method,
        write?.url,
        body.message,
        body.attachments.map((file) => [file.name, file.type, file.data.startsWith('data:image/png;base64,')]),
        typeof body.context.userAgent,
        document.body.textContent?.includes('Your feedback has been submitted.'),
      ],
      expected: ['POST', FEEDBACK_ENDPOINT, 'The Share button moved', [['a.png', 'image/png', true]], 'string', true],
    });
  });

  test('screenshots stop at five, and Remove screenshot takes one away', () => {
    dialog(fakeWeb({}).client);
    attach(Array.from({ length: 6 }, (_, index) => image(`${index}.png`)));
    const afterSix = document.querySelectorAll('img[alt$=".png"]').length;
    click(document.querySelector<HTMLButtonElement>('button[aria-label="Remove screenshot"]') as HTMLButtonElement);

    assert({
      given: 'six screenshots dropped in, then one removed',
      should: 'keep five, count them out of five, and drop the one removed',
      actual: [afterSix, document.querySelectorAll('img[alt$=".png"]').length, document.body.textContent?.includes('PNG, JPG, GIF, WebP up to 10MB (4/5)')],
      expected: [5, 4, true],
    });
  });

  test('a file that is not an image is refused', () => {
    dialog(fakeWeb({}).client);
    attach([new File(['x'], 'notes.txt', { type: 'text/plain' })]);

    assert({
      given: 'a text file dropped in',
      should: 'add no screenshot and say why',
      actual: [document.querySelectorAll('img').length, document.body.textContent?.includes('notes.txt: Only images are allowed')],
      expected: [0, true],
    });
  });
});
