import { describe, expect, it } from 'vitest';
import { renderDrive, renderDrivesList, renderPage, renderPagesList, renderPagesTree, renderTrashTree } from '@pagespace/cli';

describe('renderDrivesList (pure)', () => {
  it('renders "No drives." for an empty list', () => {
    expect(renderDrivesList([])).toBe('No drives.\n');
  });

  it('renders one stable line per drive with id, name, kind, and role', () => {
    const output = renderDrivesList([
      { id: 'drv_1', name: 'Engineering', kind: 'STANDARD', role: 'OWNER' } as never,
    ]);
    expect(output).toBe('drv_1  Engineering  [STANDARD] (OWNER)\n');
  });
});

describe('renderDrive (pure)', () => {
  it('renders id and name on one line', () => {
    expect(renderDrive({ id: 'drv_1', name: 'Engineering' })).toBe('drv_1  Engineering\n');
  });
});

describe('renderPagesList (pure)', () => {
  it('renders "No pages." for an empty list', () => {
    expect(
      renderPagesList({ mode: 'ls', driveName: 'D', driveSlug: 'd', location: '/', breadcrumb: [], pages: [], count: 0, totalInDrive: 0 } as never),
    ).toBe('No pages.\n');
  });

  it('renders one stable line per page with type, id, and title', () => {
    const output = renderPagesList({
      mode: 'ls',
      driveName: 'D',
      driveSlug: 'd',
      location: '/',
      breadcrumb: [],
      pages: [{ id: 'pg_1', title: 'RFC-1', type: 'DOCUMENT', hasChildren: false, isTaskLinked: false }],
      count: 1,
      totalInDrive: 1,
    } as never);
    expect(output).toBe('DOCUMENT  pg_1  RFC-1\n');
  });

  it('falls back to "(untitled)" for a null title', () => {
    const output = renderPagesList({
      mode: 'ls',
      driveName: 'D',
      driveSlug: 'd',
      location: '/',
      breadcrumb: [],
      pages: [{ id: 'pg_1', title: null, type: 'FOLDER', hasChildren: false, isTaskLinked: false }],
      count: 1,
      totalInDrive: 1,
    } as never);
    expect(output).toContain('(untitled)');
  });
});

describe('renderPagesTree (pure)', () => {
  const RESULT = {
    mode: 'ls' as const,
    driveName: 'D',
    driveSlug: 'd',
    location: '/',
    breadcrumb: [],
    pages: [
      { id: 'pg_root', title: 'Root Folder', type: 'FOLDER' as const, hasChildren: true, isTaskLinked: false },
      { id: 'pg_child', title: 'Child Doc', type: 'DOCUMENT' as const, hasChildren: false, isTaskLinked: false },
    ],
    count: 2,
    totalInDrive: 2,
  };

  it('renders "No pages." for an empty result', () => {
    expect(renderPagesTree({ ...RESULT, pages: [] }, new Set())).toBe('No pages.\n');
  });

  it('indents an id absent from rootIds, and does not indent one present in it', () => {
    const output = renderPagesTree(RESULT, new Set(['pg_root']));
    const lines = output.split('\n').filter(Boolean);
    expect(lines[0]).toBe('FOLDER  pg_root  Root Folder');
    expect(lines[1]).toBe('  DOCUMENT  pg_child  Child Doc');
  });
});

describe('renderPage (pure)', () => {
  it('renders type, id, and title', () => {
    expect(renderPage({ id: 'pg_1', title: 'RFC-1', type: 'DOCUMENT' } as never)).toBe('DOCUMENT  pg_1  RFC-1\n');
  });

  it('falls back to "(untitled)" for a null title', () => {
    expect(renderPage({ id: 'pg_1', title: null, type: 'DOCUMENT' } as never)).toContain('(untitled)');
  });
});

describe('renderTrashTree (pure)', () => {
  it('renders nothing for an empty tree', () => {
    expect(renderTrashTree([])).toBe('');
  });

  it('indents children strictly deeper than their parent, by true depth', () => {
    const output = renderTrashTree([
      {
        id: 'pg_1',
        title: 'Old Folder',
        type: 'FOLDER',
        children: [{ id: 'pg_2', title: 'Old Doc', type: 'DOCUMENT', children: [] }],
      },
    ] as never);
    const lines = output.split('\n').filter(Boolean);
    expect(lines[0]).toBe('FOLDER  pg_1  Old Folder');
    expect(lines[1]).toBe('  DOCUMENT  pg_2  Old Doc');
  });
});
