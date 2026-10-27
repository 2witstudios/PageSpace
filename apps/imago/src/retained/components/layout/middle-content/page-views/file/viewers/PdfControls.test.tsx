// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PdfControls, clampScale } from './PdfControls';

afterEach(cleanup);

const renderControls = (props: { pageNumber?: number; numPages?: number | null; scale?: number } = {}) => {
  const onPageChange = vi.fn();
  const onScaleChange = vi.fn();
  render(
    <PdfControls
      pageNumber={props.pageNumber ?? 1}
      numPages={props.numPages === undefined ? 6 : props.numPages}
      scale={props.scale ?? 1}
      onPageChange={onPageChange}
      onScaleChange={onScaleChange}
    />,
  );
  return { onPageChange, onScaleChange };
};

const isDisabled = (name: string) => screen.getByRole('button', { name }).hasAttribute('disabled');

describe('PdfControls pages', () => {
  it('starts on page 1 of 6: previous is disabled, next is labelled and enabled', () => {
    renderControls();
    expect(screen.getByText('1 / 6')).toBeTruthy();
    expect(isDisabled('Previous page')).toBe(true);
    expect(isDisabled('Next page')).toBe(false);
  });

  it('asks for the next page when Next page is pressed', () => {
    const { onPageChange } = renderControls();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it('on page 2 asks for the previous page, and on the last page cannot go further', () => {
    const { onPageChange } = renderControls({ pageNumber: 2, numPages: 2 });
    expect(screen.getByText('2 / 2')).toBeTruthy();
    expect(isDisabled('Next page')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(onPageChange).toHaveBeenCalledWith(1);
  });

  it('shows an unknown total while the document is still loading', () => {
    renderControls({ numPages: null });
    expect(screen.getByText('1 / …')).toBeTruthy();
    expect(isDisabled('Next page')).toBe(true);
  });
});

describe('PdfControls zoom', () => {
  it('shows 100% at the default scale and zooms in by a quarter', () => {
    const { onScaleChange } = renderControls();
    expect(screen.getByText('100%')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(onScaleChange).toHaveBeenCalledWith(1.25);
  });

  it('zooms out by a quarter from a zoomed view, showing the percentage it is at', () => {
    const { onScaleChange } = renderControls({ scale: 1.25 });
    expect(screen.getByText('125%')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(onScaleChange).toHaveBeenCalledWith(1);
  });

  it('will not zoom past the limits', () => {
    renderControls({ scale: 3 });
    expect(isDisabled('Zoom in')).toBe(true);
    cleanup();
    renderControls({ scale: 0.5 });
    expect(screen.getByText('50%')).toBeTruthy();
    expect(isDisabled('Zoom out')).toBe(true);
  });
});

describe('clampScale', () => {
  it('keeps the scale between 50% and 300%', () => {
    expect(clampScale(0.1)).toBe(0.5);
    expect(clampScale(9)).toBe(3);
    expect(clampScale(1.5)).toBe(1.5);
  });
});
