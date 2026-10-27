import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, createEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FilesEmptyState } from '../FilesEmptyState';

const hoisted = vi.hoisted(() => ({
  uploadFileToS3: vi.fn(),
  toastError: vi.fn(),
  startEditing: vi.fn(),
  endEditing: vi.fn(),
  openQuickCreate: vi.fn(),
}));

vi.mock('@/stores/useUIStore', () => ({
  useUIStore: (selector: (s: { openQuickCreate: typeof hoisted.openQuickCreate }) => unknown) =>
    selector({ openQuickCreate: hoisted.openQuickCreate }),
}));

vi.mock('@/lib/upload/orchestrator', () => ({
  uploadFileToS3: hoisted.uploadFileToS3,
}));

vi.mock('sonner', () => ({
  toast: {
    error: hoisted.toastError,
    success: vi.fn(),
  },
}));

vi.mock('@/stores/useEditingStore', () => ({
  useEditingStore: {
    getState: () => ({
      startEditing: hoisted.startEditing,
      endEditing: hoisted.endEditing,
    }),
  },
}));

describe('FilesEmptyState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.uploadFileToS3.mockResolvedValue({ id: 'new-page' });
  });

  it('renders read-only message and no CTAs when user has no drive role', () => {
    render(
      <FilesEmptyState driveId="drive-1" parentId={null} canWrite={false} onMutate={vi.fn()} />
    );

    expect(screen.getByText(/view-only access/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /upload files/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /create page/i })).not.toBeInTheDocument();
  });

  it('renders both CTAs and onboarding subheadline when user can write', () => {
    render(
      <FilesEmptyState driveId="drive-1" parentId={null} canWrite={true} onMutate={vi.fn()} />
    );

    expect(screen.getByText('No pages in this drive')).toBeInTheDocument();
    expect(screen.getByText(/upload files or create a page to get started/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /upload files/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create page/i })).toBeInTheDocument();
  });

  it('uses nested-folder headline when parentId is provided', () => {
    render(
      <FilesEmptyState driveId="drive-1" parentId="page-42" canWrite={true} onMutate={vi.fn()} />
    );

    expect(screen.getByText('No child pages')).toBeInTheDocument();
  });

  it('calls openQuickCreate with parentId when Create page is clicked', async () => {
    const user = userEvent.setup();
    render(
      <FilesEmptyState driveId="drive-1" parentId="page-42" canWrite={true} onMutate={vi.fn()} />
    );

    await user.click(screen.getByRole('button', { name: /create page/i }));

    expect(hoisted.openQuickCreate).toHaveBeenCalledWith('page-42');
  });

  it('triggers the hidden file picker when Upload files is clicked', async () => {
    const user = userEvent.setup();
    render(
      <FilesEmptyState driveId="drive-1" parentId={null} canWrite={true} onMutate={vi.fn()} />
    );

    const fileInput = screen.getByTestId('files-upload-input') as HTMLInputElement;
    const clickSpy = vi.spyOn(fileInput, 'click');

    await user.click(screen.getByRole('button', { name: /upload files/i }));

    expect(clickSpy).toHaveBeenCalledOnce();
  });

  it('shows a drop-zone cue while a file is dragged over the panel', () => {
    render(
      <FilesEmptyState driveId="drive-1" parentId={null} canWrite={true} onMutate={vi.fn()} />
    );

    const panel = screen.getByTestId('files-empty-state');
    expect(panel.getAttribute('data-drop-active')).toBe('false');

    fireEvent.dragEnter(panel, { dataTransfer: { types: ['Files'] } });
    fireEvent.dragOver(panel, { dataTransfer: { types: ['Files'] } });
    expect(panel.getAttribute('data-drop-active')).toBe('true');

    fireEvent.dragLeave(panel, { relatedTarget: document.body });
    expect(panel.getAttribute('data-drop-active')).toBe('false');
  });

  it('keeps the drop-zone cue active when the drag moves to a child element', () => {
    render(
      <FilesEmptyState driveId="drive-1" parentId={null} canWrite={true} onMutate={vi.fn()} />
    );

    const panel = screen.getByTestId('files-empty-state');
    const childButton = screen.getByRole('button', { name: /upload files/i });

    fireEvent.dragEnter(panel, { dataTransfer: { types: ['Files'] } });
    fireEvent.dragOver(panel, { dataTransfer: { types: ['Files'] } });
    expect(panel.getAttribute('data-drop-active')).toBe('true');

    const leaveEvent = createEvent.dragLeave(panel);
    Object.defineProperty(leaveEvent, 'relatedTarget', { value: childButton });
    fireEvent(panel, leaveEvent);
    expect(panel.getAttribute('data-drop-active')).toBe('true');
  });

  it('uploads each dropped file via uploadFileToS3 with driveId and parentId', async () => {
    const onMutate = vi.fn();
    render(
      <FilesEmptyState driveId="drive-7" parentId="page-42" canWrite={true} onMutate={onMutate} />
    );

    const panel = screen.getByTestId('files-empty-state');
    const file1 = new File(['one'], 'one.txt', { type: 'text/plain' });
    const file2 = new File(['two'], 'two.md', { type: 'text/markdown' });

    await act(async () => {
      fireEvent.drop(panel, { dataTransfer: { files: [file1, file2], types: ['Files'] } });
    });

    await waitFor(() => {
      expect(hoisted.uploadFileToS3).toHaveBeenCalledTimes(2);
    });

    const [firstCall, secondCall] = hoisted.uploadFileToS3.mock.calls;
    expect((firstCall[0] as File).name).toBe('one.txt');
    expect(firstCall[1]).toEqual({ driveId: 'drive-7', parentId: 'page-42' });
    expect((secondCall[0] as File).name).toBe('two.md');
    expect(onMutate).toHaveBeenCalled();
  });

  it('uploads files selected via the hidden file picker', async () => {
    render(
      <FilesEmptyState driveId="drive-7" parentId={null} canWrite={true} onMutate={vi.fn()} />
    );

    const fileInput = screen.getByTestId('files-upload-input') as HTMLInputElement;
    const file = new File(['hi'], 'hi.txt', { type: 'text/plain' });

    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [file] } });
    });

    await waitFor(() => {
      expect(hoisted.uploadFileToS3).toHaveBeenCalledTimes(1);
    });
    const [fileArg, target] = hoisted.uploadFileToS3.mock.calls[0];
    expect((fileArg as File).name).toBe('hi.txt');
    expect(target).toEqual({ driveId: 'drive-7', parentId: null });
  });

  it('ignores drops when the user lacks drive role', async () => {
    render(
      <FilesEmptyState driveId="drive-7" parentId={null} canWrite={false} onMutate={vi.fn()} />
    );

    expect(screen.queryByTestId('files-empty-state')).not.toBeInTheDocument();
    const panel = screen.getByTestId('files-empty-state-readonly');
    const file = new File(['one'], 'one.txt', { type: 'text/plain' });

    await act(async () => {
      fireEvent.drop(panel, { dataTransfer: { files: [file], types: ['Files'] } });
    });

    expect(hoisted.uploadFileToS3).not.toHaveBeenCalled();
  });

  it('registers and releases an editing-store session around the upload batch', async () => {
    render(
      <FilesEmptyState driveId="drive-7" parentId={null} canWrite={true} onMutate={vi.fn()} />
    );

    const panel = screen.getByTestId('files-empty-state');
    const file = new File(['x'], 'x.txt', { type: 'text/plain' });

    await act(async () => {
      fireEvent.drop(panel, { dataTransfer: { files: [file], types: ['Files'] } });
    });

    await waitFor(() => {
      expect(hoisted.startEditing).toHaveBeenCalledTimes(1);
      expect(hoisted.endEditing).toHaveBeenCalledTimes(1);
    });
    const [startId, startType] = hoisted.startEditing.mock.calls[0];
    const [endId] = hoisted.endEditing.mock.calls[0];
    expect(startType).toBe('form');
    expect(endId).toBe(startId);
  });

  it('shows a toast.error for a failed upload but continues the batch', async () => {
    hoisted.uploadFileToS3
      .mockRejectedValueOnce(new Error('too large'))
      .mockResolvedValueOnce({ id: 'ok-page' });

    render(
      <FilesEmptyState driveId="drive-7" parentId={null} canWrite={true} onMutate={vi.fn()} />
    );

    const panel = screen.getByTestId('files-empty-state');
    const bad = new File(['big'], 'big.bin', { type: 'application/octet-stream' });
    const good = new File(['ok'], 'ok.txt', { type: 'text/plain' });

    await act(async () => {
      fireEvent.drop(panel, { dataTransfer: { files: [bad, good], types: ['Files'] } });
    });

    await waitFor(() => {
      expect(hoisted.uploadFileToS3).toHaveBeenCalledTimes(2);
    });
    expect(hoisted.toastError).toHaveBeenCalledWith(expect.stringContaining('too large'));
  });
});
