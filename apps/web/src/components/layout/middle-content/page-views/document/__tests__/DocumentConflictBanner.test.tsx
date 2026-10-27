import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import DocumentConflictBanner from '../DocumentConflictBanner';

const conflict = {
  remoteContent: '<p>their text</p>',
  remoteRevision: 11,
  detectedAt: 1,
};

describe('DocumentConflictBanner', () => {
  it('given a conflict, should say the local changes are unsent and what each choice overwrites', () => {
    render(<DocumentConflictBanner conflict={conflict} onResolve={vi.fn()} />);

    const banner = screen.getByTestId('document-conflict-banner');
    expect(banner.textContent).toContain('Your unsaved changes are still in the editor');
    expect(banner.textContent).toContain('have not been sent');
    expect(banner.textContent).toContain('replaces their version in the document');
    expect(banner.textContent).toContain('discards your unsaved changes');
  });

  it('should not promise the discarded version is recoverable', () => {
    render(<DocumentConflictBanner conflict={conflict} onResolve={vi.fn()} />);

    const banner = screen.getByTestId('document-conflict-banner');
    expect(banner.textContent).not.toContain('recoverable');
    expect(banner.textContent).not.toContain('history');
  });

  it('given the user asks to see the other version, should render the parked remote content', () => {
    render(<DocumentConflictBanner conflict={conflict} onResolve={vi.fn()} />);

    expect(screen.queryByTestId('document-conflict-remote-preview')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'View their version' }));

    expect(screen.getByTestId('document-conflict-remote-preview').textContent).toContain(
      'their text'
    );
  });

  it('given remote content carrying a script, should render it sanitized', () => {
    render(
      <DocumentConflictBanner
        conflict={{ ...conflict, remoteContent: '<p>hi</p><script>alert(1)</script>' }}
        onResolve={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'View their version' }));

    const preview = screen.getByTestId('document-conflict-remote-preview');
    expect(preview.textContent).toContain('hi');
    expect(preview.querySelector('script')).toBeNull();
  });

  it('given plain preview mode, should show the other version verbatim', () => {
    render(
      <DocumentConflictBanner
        conflict={{ ...conflict, remoteContent: '# their heading' }}
        previewMode="plain"
        onResolve={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'View their version' }));

    const preview = screen.getByTestId('document-conflict-remote-preview');
    expect(preview.querySelector('pre')?.textContent).toBe('# their heading');
  });

  it('given Keep mine is clicked, should resolve with keep-mine', () => {
    const onResolve = vi.fn();
    render(<DocumentConflictBanner conflict={conflict} onResolve={onResolve} />);

    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }));

    expect(onResolve).toHaveBeenCalledWith('keep-mine');
  });

  it('given Use theirs is clicked, should resolve with use-theirs', () => {
    const onResolve = vi.fn();
    render(<DocumentConflictBanner conflict={conflict} onResolve={onResolve} />);

    fireEvent.click(screen.getByRole('button', { name: 'Use theirs' }));

    expect(onResolve).toHaveBeenCalledWith('use-theirs');
  });

  it('given a resolution in flight, should disable both choices', () => {
    render(<DocumentConflictBanner conflict={conflict} onResolve={vi.fn()} isResolving />);

    expect(screen.getByRole('button', { name: 'Keep mine' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Use theirs' })).toBeDisabled();
  });
});
