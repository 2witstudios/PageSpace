import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent, screen, act } from '@testing-library/react';
import React from 'react';

import { MessageDropZone } from '../MessageDropZone';
import type { ChannelInputRef } from '../ChannelInput';

const makeInputRef = (overrides: Partial<ChannelInputRef> = {}) => {
  const uploadFiles = vi.fn();
  const canAcceptDrop = vi.fn(() => true);
  const ref: React.RefObject<ChannelInputRef | null> = {
    current: {
      focus: vi.fn(),
      clear: vi.fn(),
      insertText: vi.fn(),
      uploadFiles,
      canAcceptDrop,
      ...overrides,
    } satisfies ChannelInputRef,
  };
  return { ref, uploadFiles, canAcceptDrop };
};

const fireDragEvent = (
  el: Element,
  type: 'dragEnter' | 'dragOver' | 'dragLeave' | 'drop',
  init: { files?: File[]; types?: string[] } = {},
) => {
  const types = init.types ?? (init.files ? ['Files'] : []);
  const files = init.files ?? [];
  fireEvent[type](el, {
    dataTransfer: {
      files,
      types,
      items: files.map((f) => ({ kind: 'file', type: f.type })),
      // dropEffect is set by the handler; provide a settable shape.
      dropEffect: 'none',
    },
  });
};

const renderZone = (
  inputRef: React.RefObject<ChannelInputRef | null>,
  enabled = true,
) =>
  render(
    <MessageDropZone inputRef={inputRef} enabled={enabled}>
      <div data-testid="zone-children">children</div>
    </MessageDropZone>,
  );

const dropZone = () => screen.getByTestId('message-drop-zone');

describe('MessageDropZone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('drop_withFile_callsUploadFiles_withAllFiles', () => {
    const { ref, uploadFiles } = makeInputRef();
    renderZone(ref);

    const file = new File(['x'], 'a.png', { type: 'image/png' });
    fireDragEvent(dropZone(), 'drop', { files: [file] });

    expect(uploadFiles).toHaveBeenCalledTimes(1);
    expect(uploadFiles).toHaveBeenCalledWith([file]);
  });

  it('drop_withMultipleFiles_callsUploadFiles_withAllFiles', () => {
    const { ref, uploadFiles } = makeInputRef();
    renderZone(ref);

    const f1 = new File(['1'], 'one.png', { type: 'image/png' });
    const f2 = new File(['2'], 'two.png', { type: 'image/png' });
    fireDragEvent(dropZone(), 'drop', { files: [f1, f2] });

    expect(uploadFiles).toHaveBeenCalledTimes(1);
    expect(uploadFiles).toHaveBeenCalledWith([f1, f2]);
  });

  it('drop_withoutFilesType_isIgnored', () => {
    const { ref, uploadFiles } = makeInputRef();
    renderZone(ref);

    // Simulate an in-app drag (e.g. a URL or text), not a file drag.
    fireDragEvent(dropZone(), 'drop', { types: ['text/plain'] });

    expect(uploadFiles).not.toHaveBeenCalled();
  });

  it('drop_whenDisabled_isIgnored', () => {
    const { ref, uploadFiles } = makeInputRef();
    renderZone(ref, /* enabled */ false);

    const file = new File(['x'], 'a.png', { type: 'image/png' });
    fireDragEvent(dropZone(), 'drop', { files: [file] });

    expect(uploadFiles).not.toHaveBeenCalled();
  });

  it('drop_whenCanAcceptDropFalse_isIgnored', () => {
    const { ref, uploadFiles, canAcceptDrop } = makeInputRef();
    canAcceptDrop.mockReturnValue(false);
    renderZone(ref);

    const file = new File(['x'], 'a.png', { type: 'image/png' });
    fireDragEvent(dropZone(), 'drop', { files: [file] });

    expect(uploadFiles).not.toHaveBeenCalled();
  });

  it('dragEnter_withFiles_showsOverlay_dragLeaveHidesIt', () => {
    const { ref } = makeInputRef();
    renderZone(ref);

    expect(screen.queryByText('Drop files to attach')).toBeNull();

    fireDragEvent(dropZone(), 'dragEnter', { files: [new File([''], 'a')] });
    expect(screen.getByText('Drop files to attach')).toBeInTheDocument();

    fireDragEvent(dropZone(), 'dragLeave', { files: [new File([''], 'a')] });
    expect(screen.queryByText('Drop files to attach')).toBeNull();
  });

  it('dragEnter_withoutFilesType_doesNotShowOverlay', () => {
    const { ref } = makeInputRef();
    renderZone(ref);

    fireDragEvent(dropZone(), 'dragEnter', { types: ['text/plain'] });
    expect(screen.queryByText('Drop files to attach')).toBeNull();
  });

  it('dragEnter_whenDisabled_doesNotShowOverlay', () => {
    const { ref } = makeInputRef();
    renderZone(ref, false);

    fireDragEvent(dropZone(), 'dragEnter', { files: [new File([''], 'a')] });
    expect(screen.queryByText('Drop files to attach')).toBeNull();
  });

  it('dragEnter_whenCanAcceptDropFalse_doesNotShowOverlay', () => {
    const { ref, canAcceptDrop } = makeInputRef();
    canAcceptDrop.mockReturnValue(false);
    renderZone(ref);

    fireDragEvent(dropZone(), 'dragEnter', { files: [new File([''], 'a')] });
    expect(screen.queryByText('Drop files to attach')).toBeNull();
  });

  it('drop_resetsOverlay_evenAfterMultipleDragEnters', () => {
    const { ref } = makeInputRef();
    renderZone(ref);

    // Multiple dragEnter events (children causing storm)
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    fireDragEvent(dropZone(), 'dragEnter', { files: [file] });
    fireDragEvent(dropZone(), 'dragEnter', { files: [file] });
    expect(screen.getByText('Drop files to attach')).toBeInTheDocument();

    fireDragEvent(dropZone(), 'drop', { files: [file] });
    expect(screen.queryByText('Drop files to attach')).toBeNull();
  });

  it('windowDrop_event_resetsOverlay_whenUserDragsOutOfWindow', () => {
    const { ref } = makeInputRef();
    renderZone(ref);

    fireDragEvent(dropZone(), 'dragEnter', { files: [new File([''], 'a')] });
    expect(screen.getByText('Drop files to attach')).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new Event('drop'));
    });
    expect(screen.queryByText('Drop files to attach')).toBeNull();
  });

  it('childDropStopsPropagation_overlayStillResets_viaCaptureListener', () => {
    // Reproduces the composer-drop-with-stopPropagation case: an inner element
    // calls stopPropagation, so MessageDropZone's own onDrop never fires.
    // The capture-phase window listener must still reset the overlay.
    const { ref } = makeInputRef();
    render(
      <MessageDropZone inputRef={ref} enabled>
        <button
          data-testid="inner-target"
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          inner
        </button>
      </MessageDropZone>,
    );

    const file = new File(['x'], 'a.png', { type: 'image/png' });
    fireDragEvent(dropZone(), 'dragEnter', { files: [file] });
    expect(screen.getByText('Drop files to attach')).toBeInTheDocument();

    fireDragEvent(screen.getByTestId('inner-target'), 'drop', { files: [file] });
    expect(screen.queryByText('Drop files to attach')).toBeNull();
  });

  it('documentDragLeave_withNullRelatedTarget_resetsOverlay', () => {
    const { ref } = makeInputRef();
    renderZone(ref);

    fireDragEvent(dropZone(), 'dragEnter', { files: [new File([''], 'a')] });
    expect(screen.getByText('Drop files to attach')).toBeInTheDocument();

    act(() => {
      const ev = new Event('dragleave', { bubbles: true });
      Object.defineProperty(ev, 'relatedTarget', { value: null });
      document.dispatchEvent(ev);
    });
    expect(screen.queryByText('Drop files to attach')).toBeNull();
  });

  it('documentDragLeave_withRelatedTarget_doesNotReset', () => {
    const { ref } = makeInputRef();
    renderZone(ref);

    fireDragEvent(dropZone(), 'dragEnter', { files: [new File([''], 'a')] });
    expect(screen.getByText('Drop files to attach')).toBeInTheDocument();

    act(() => {
      const ev = new Event('dragleave', { bubbles: true });
      Object.defineProperty(ev, 'relatedTarget', { value: document.body });
      document.dispatchEvent(ev);
    });
    expect(screen.getByText('Drop files to attach')).toBeInTheDocument();
  });

  it('enabledFalse_afterMount_resetsOverlayIfActive', () => {
    const { ref } = makeInputRef();
    const { rerender } = renderZone(ref, true);

    fireDragEvent(dropZone(), 'dragEnter', { files: [new File([''], 'a')] });
    expect(screen.getByText('Drop files to attach')).toBeInTheDocument();

    rerender(
      <MessageDropZone inputRef={ref} enabled={false}>
        <div>children</div>
      </MessageDropZone>,
    );
    expect(screen.queryByText('Drop files to attach')).toBeNull();
  });
});
