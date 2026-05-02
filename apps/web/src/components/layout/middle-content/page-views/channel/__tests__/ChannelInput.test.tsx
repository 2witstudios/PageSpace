import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

import type { FileAttachment } from '@/hooks/useAttachmentUpload';

// Mock motion/react to render-through children synchronously
vi.mock('motion/react', () => {
  const passthrough = (Tag: keyof React.JSX.IntrinsicElements) => {
    const C = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(
      ({ children, ...props }, ref) =>
        React.createElement(
          Tag,
          {
            ...Object.fromEntries(
              Object.entries(props).filter(
                ([k]) =>
                  !k.startsWith('initial') &&
                  !k.startsWith('animate') &&
                  !k.startsWith('exit') &&
                  !k.startsWith('whileTap') &&
                  !k.startsWith('whileHover') &&
                  !k.startsWith('transition') &&
                  !k.startsWith('layout'),
              ),
            ),
            ref,
          },
          children,
        ),
    );
    C.displayName = `motion.${String(Tag)}`;
    return C;
  };
  return {
    motion: new Proxy(
      {},
      {
        get: (_t, prop: string) => passthrough(prop as keyof React.JSX.IntrinsicElements),
      },
    ),
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useReducedMotion: () => false,
  };
});

// Mock ChatTextarea so we can drive paste/keyboard without booting the suggestion stack.
// Captures the props it received so tests can assert on `onPasteFiles`, `driveId`, etc.
// `vi.hoisted` lets the value be referenced from `vi.mock` factories (which are hoisted).
const { chatTextareaProps } = vi.hoisted(() => ({
  chatTextareaProps: vi.fn(),
}));
vi.mock('@/components/ai/chat/input/ChatTextarea', () => {
  interface MockProps {
    value: string;
    onChange: (v: string) => void;
    onSend: () => void;
    placeholder?: string;
    driveId?: string;
    onPasteFiles?: (files: File[]) => void;
    disabled?: boolean;
  }
  const MockChatTextarea = React.forwardRef<
    { focus: () => void; clear: () => void },
    MockProps
  >((props, ref) => {
    chatTextareaProps(props);
    React.useImperativeHandle(ref, () => ({ focus: vi.fn(), clear: vi.fn() }));
    return (
      <textarea
        data-testid="chat-textarea"
        value={props.value}
        placeholder={props.placeholder}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            props.onSend();
          }
        }}
        onPaste={(e) => {
          if (!props.onPasteFiles) return;
          const items = Array.from(e.clipboardData?.items ?? []);
          const files: File[] = [];
          for (const it of items) {
            if (it.kind === 'file' && it.type.startsWith('image/')) {
              const f = it.getAsFile();
              if (f) files.push(f);
            }
          }
          if (files.length > 0) {
            e.preventDefault();
            props.onPasteFiles(files);
          }
        }}
      />
    );
  });
  MockChatTextarea.displayName = 'MockChatTextarea';
  return { ChatTextarea: MockChatTextarea };
});

// Mock the footer so test queries don't fight popovers/tooltips
vi.mock('../ChannelInputFooter', () => ({
  ChannelInputFooter: ({
    onAttachmentClick,
    attachmentsEnabled,
    disabled,
  }: {
    onAttachmentClick?: () => void;
    attachmentsEnabled?: boolean;
    disabled?: boolean;
  }) => (
    <div data-testid="channel-input-footer">
      {attachmentsEnabled && (
        <button
          type="button"
          data-testid="attach-button"
          onClick={onAttachmentClick}
          disabled={disabled}
        >
          Attach
        </button>
      )}
    </div>
  ),
}));

// Capture useAttachmentUpload args + expose a controllable mock state
const uploadHookCalls: Array<{
  uploadUrl: string | null | undefined;
  onUploaded?: (a: FileAttachment) => void;
}> = [];
let mockAttachment: FileAttachment | null = null;
let mockIsUploading = false;
const mockUploadFile = vi.fn(async (_file: File) => {});
const mockClearAttachment = vi.fn(() => {
  mockAttachment = null;
});
vi.mock('@/hooks/useAttachmentUpload', async () => {
  const actual =
    await vi.importActual<typeof import('@/hooks/useAttachmentUpload')>(
      '@/hooks/useAttachmentUpload',
    );
  return {
    ...actual,
    useAttachmentUpload: (opts: {
      uploadUrl: string | null | undefined;
      onUploaded?: (a: FileAttachment) => void;
    }) => {
      uploadHookCalls.push(opts);
      return {
        attachment: mockAttachment,
        isUploading: mockIsUploading,
        uploadFile: mockUploadFile,
        clearAttachment: mockClearAttachment,
      };
    },
  };
});

import { ChannelInput } from '../ChannelInput';

const sampleAttachment: FileAttachment = {
  id: 'file-abc',
  originalName: 'photo.png',
  size: 12345,
  mimeType: 'image/png',
  contentHash: 'hash-abc',
};

const renderInput = (overrides: Partial<React.ComponentProps<typeof ChannelInput>> = {}) => {
  const onChange = vi.fn();
  const onSend = vi.fn();
  const utils = render(
    <ChannelInput
      value=""
      onChange={onChange}
      onSend={onSend}
      attachmentsEnabled
      conversationId="conv-1"
      {...overrides}
    />,
  );
  return { ...utils, onChange, onSend };
};

describe('ChannelInput — DM upload mode (conversationId)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uploadHookCalls.length = 0;
    chatTextareaProps.mockClear();
    mockAttachment = null;
    mockIsUploading = false;
  });

  it('uploadUrl_isComputedFromConversationId_whenChannelIdAbsent', () => {
    renderInput({ conversationId: 'conv-42', channelId: undefined });

    expect(uploadHookCalls.length).toBeGreaterThan(0);
    expect(uploadHookCalls[uploadHookCalls.length - 1].uploadUrl).toBe(
      '/api/messages/conv-42/upload',
    );
  });

  it('uploadUrl_prefersChannelId_whenBothProvided', () => {
    renderInput({ conversationId: 'conv-42', channelId: 'page-7' });

    expect(uploadHookCalls[uploadHookCalls.length - 1].uploadUrl).toBe(
      '/api/channels/page-7/upload',
    );
  });

  it('uploadUrl_isNull_whenNeitherChannelIdNorConversationIdProvided', () => {
    renderInput({ conversationId: undefined, channelId: undefined });

    expect(uploadHookCalls[uploadHookCalls.length - 1].uploadUrl).toBeNull();
  });

  it('textOnly_send_callsOnSendWithoutAttachment', async () => {
    const user = userEvent.setup();
    const { onSend } = renderInput({ value: 'hello world' });

    const textarea = screen.getByTestId('chat-textarea');
    await user.type(textarea, '{enter}');

    expect(onSend).toHaveBeenCalledWith(undefined);
  });

  it('textAndAttachment_send_callsOnSendWithAttachmentObject', async () => {
    mockAttachment = sampleAttachment;
    const user = userEvent.setup();
    const { onSend } = renderInput({ value: 'with file' });

    await user.type(screen.getByTestId('chat-textarea'), '{enter}');

    expect(onSend).toHaveBeenCalledWith(sampleAttachment);
    expect(mockClearAttachment).toHaveBeenCalledTimes(1);
  });

  it('attachmentOnly_emptyText_send_callsOnSendWithAttachment_andDoesNotBlockSend', async () => {
    mockAttachment = sampleAttachment;
    const user = userEvent.setup();
    const { onSend } = renderInput({ value: '' });

    // Empty textarea + Enter should still send because there is an attachment.
    await user.type(screen.getByTestId('chat-textarea'), '{enter}');

    expect(onSend).toHaveBeenCalledWith(sampleAttachment);
  });

  it('isUploading_disablesSendButton_andEnterToSend', async () => {
    mockIsUploading = true;
    const user = userEvent.setup();
    const { onSend } = renderInput({ value: 'hello' });

    const sendBtn = screen.getByRole('button', { name: /send message/i });
    expect(sendBtn).toBeDisabled();

    await user.type(screen.getByTestId('chat-textarea'), '{enter}');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('clearAttachment_removesPreview_andRevertsCanSendToTextOnly', async () => {
    mockAttachment = sampleAttachment;
    const user = userEvent.setup();
    const { rerender } = renderInput({ value: '' });

    // Preview is visible
    expect(screen.getByText('photo.png')).toBeInTheDocument();
    const remove = screen.getByRole('button', { name: /remove attachment/i });
    await user.click(remove);
    expect(mockClearAttachment).toHaveBeenCalledTimes(1);

    // Simulate the hook clearing by re-rendering with attachment null + empty value
    mockAttachment = null;
    rerender(
      <ChannelInput
        value=""
        onChange={vi.fn()}
        onSend={vi.fn()}
        attachmentsEnabled
        conversationId="conv-1"
      />,
    );
    const sendBtn = screen.getByRole('button', { name: /send message/i });
    expect(sendBtn).toBeDisabled();
  });

  it('pasteImageFile_invokesUploadFile_withTheFile', () => {
    renderInput();

    const file = new File(['x'], 'pasted.png', { type: 'image/png' });
    const textarea = screen.getByTestId('chat-textarea');

    fireEvent.paste(textarea, {
      clipboardData: {
        items: [
          {
            kind: 'file',
            type: 'image/png',
            getAsFile: () => file,
          },
        ],
      },
    });

    expect(mockUploadFile).toHaveBeenCalledTimes(1);
    expect(mockUploadFile).toHaveBeenCalledWith(file);
  });

  it('pastePlainText_doesNotInvokeUploadFile', () => {
    renderInput();
    const textarea = screen.getByTestId('chat-textarea');

    fireEvent.paste(textarea, {
      clipboardData: {
        items: [
          {
            kind: 'string',
            type: 'text/plain',
            getAsFile: () => null,
          },
        ],
      },
    });

    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  it('dragDropImageFile_invokesUploadFile_withTheFile', () => {
    const { container } = renderInput();

    const file = new File(['x'], 'dropped.png', { type: 'image/png' });
    const wrapper = container.querySelector('[data-testid="channel-input-root"]');
    expect(wrapper).not.toBeNull();

    fireEvent.dragOver(wrapper as Element, {
      dataTransfer: { files: [file], types: ['Files'] },
    });
    fireEvent.drop(wrapper as Element, {
      dataTransfer: {
        files: [file],
        types: ['Files'],
      },
    });

    expect(mockUploadFile).toHaveBeenCalledTimes(1);
    expect(mockUploadFile).toHaveBeenCalledWith(file);
  });

  it('filePickerButton_choosingFile_invokesUploadFile', () => {
    const { container } = renderInput();

    const attach = screen.getByTestId('attach-button');
    fireEvent.click(attach);

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).toBeTruthy();

    const file = new File(['x'], 'picked.pdf', { type: 'application/pdf' });
    fireEvent.change(fileInput, { target: { files: [file] } });

    expect(mockUploadFile).toHaveBeenCalledTimes(1);
    expect(mockUploadFile).toHaveBeenCalledWith(file);
  });

  it('attachmentsDisabled_doesNotShowPicker_andIgnoresPaste', () => {
    renderInput({ attachmentsEnabled: false });

    expect(screen.queryByTestId('attach-button')).toBeNull();

    const file = new File(['x'], 'pasted.png', { type: 'image/png' });
    const textarea = screen.getByTestId('chat-textarea');
    fireEvent.paste(textarea, {
      clipboardData: {
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
      },
    });

    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  it('mentionsAndIme_propsForwardedToChatTextarea_unchangedByAttachmentFeature', () => {
    mockAttachment = sampleAttachment;
    renderInput({ driveId: 'drive-1', crossDrive: true });

    const last = chatTextareaProps.mock.calls.at(-1)?.[0] as
      | { driveId?: string; crossDrive?: boolean; popupPlacement?: string; variant?: string }
      | undefined;
    expect(last?.driveId).toBe('drive-1');
    expect(last?.crossDrive).toBe(true);
    expect(last?.popupPlacement).toBe('top');
  });
});
