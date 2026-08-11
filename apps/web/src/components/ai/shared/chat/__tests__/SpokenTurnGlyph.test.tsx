/**
 * A spoken turn is marked in the thread, in BOTH renderers.
 *
 * The transcript is the artifact of record — it is all that survives a call —
 * and it lands beside typed messages that look exactly like it. A dictated
 * sentence runs long, repeats itself, and carries whatever the transcriber
 * heard; read as typing it looks careless. The glyph is the whole fix, and it
 * has to be in both renderers because a conversation opened in the sidebar and
 * the same conversation opened in the main view are the same conversation.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { MESSAGE_SOURCE_VOICE } from '@pagespace/db/schema/conversations';
import type { ConversationMessage } from '../message-types';

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1', name: 'Me' } }) }));
vi.mock('@/hooks/useTasks', () => ({ useTasks: () => ({ tasks: [], isLoading: false }) }));

import { CompactMessageRenderer } from '../CompactMessageRenderer';
import { MessageRenderer } from '../MessageRenderer';

const message = (source: string | null): ConversationMessage =>
  ({
    id: 'm1',
    role: 'user',
    parts: [{ type: 'text', text: 'what is on this page' }],
    createdAt: new Date('2026-01-01T10:00:00Z'),
    messageType: 'standard',
    source,
  }) as ConversationMessage;

describe.each([
  ['CompactMessageRenderer', CompactMessageRenderer],
  ['MessageRenderer', MessageRenderer],
])('%s — marking a spoken turn', (_name, Renderer) => {
  it('should mark a voice-authored row', () => {
    render(<Renderer message={message(MESSAGE_SOURCE_VOICE)} />);
    expect(screen.getByTestId('spoken-turn-glyph')).toBeInTheDocument();
    // Named for screen readers, which get nothing from an icon.
    expect(screen.getByText('Spoken in a voice call')).toBeInTheDocument();
  });

  it('should leave a typed row unmarked', () => {
    render(<Renderer message={message(null)} />);
    expect(screen.queryByTestId('spoken-turn-glyph')).not.toBeInTheDocument();
  });

  it('should not mark a row that merely mentions voice', () => {
    // The check is on the transport column, not on anything in the content.
    render(<Renderer message={{ ...message('typed'), source: 'typed' }} />);
    expect(screen.queryByTestId('spoken-turn-glyph')).not.toBeInTheDocument();
  });
});
