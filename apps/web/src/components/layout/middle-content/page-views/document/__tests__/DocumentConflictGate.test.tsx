import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import DocumentConflictGate from '../DocumentConflictGate';

const conflict = {
  remoteContent: '<p>their text</p>',
  remoteRevision: 11,
  detectedAt: 1,
};

describe('DocumentConflictGate', () => {
  it('given no conflict, should render nothing so views can mount it unconditionally', () => {
    const { container } = render(
      <DocumentConflictGate conflict={undefined} onResolve={vi.fn()} />
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('given a conflict, should surface the resolve UI', () => {
    render(<DocumentConflictGate conflict={conflict} onResolve={vi.fn()} />);

    expect(screen.getByTestId('document-conflict-banner')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep mine' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use theirs' })).toBeInTheDocument();
  });

  it('should pass the caller-owned resolver straight through', () => {
    const onResolve = vi.fn();
    render(<DocumentConflictGate conflict={conflict} onResolve={onResolve} />);

    screen.getByRole('button', { name: 'Keep mine' }).click();

    expect(onResolve).toHaveBeenCalledWith('keep-mine');
  });
});
