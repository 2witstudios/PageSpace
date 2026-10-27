/**
 * The slug-level Status filter merges every list's statuses in the current
 * page of results. Inside one drive that is that drive's vocabulary; across
 * all drives it is an arbitrary union, so the filter is only offered in a drive.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FilterControls } from '../FilterControls';

const configs = {
  list_1: [{ slug: 'pending', label: 'Backlog', group: 'todo', position: 0, color: 'gray' }],
} as never;

const renderControls = (scopedToDrive: boolean, layout: 'mobile' | 'desktop' = 'desktop') =>
  render(
    <FilterControls
      layout={layout}
      scopedToDrive={scopedToDrive}
      filters={{}}
      hasActiveFilters={false}
      statusConfigsByTaskList={configs}
      onFiltersChange={vi.fn()}
      onClearFilters={vi.fn()}
    />
  );

describe('FilterControls status filter', () => {
  it('given a drive focus, should offer the slug-level Status filter', () => {
    renderControls(true);
    expect(screen.getByText('All statuses')).toBeInTheDocument();
  });

  it('given the All drives focus, should offer only the status group', () => {
    renderControls(false);
    expect(screen.queryByText('All statuses')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /active/i })).toBeInTheDocument();
  });

  it('given the phone layout in the All drives focus, should also drop the slug filter', () => {
    renderControls(false, 'mobile');
    expect(screen.queryByText('All statuses')).not.toBeInTheDocument();
  });

  it('given any focus, should never offer a Drive select — the focus is the drive', () => {
    renderControls(true);
    expect(screen.queryByText('All drives')).not.toBeInTheDocument();
  });
});
