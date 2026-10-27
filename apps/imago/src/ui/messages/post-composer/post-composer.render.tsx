import type { ReactNode } from 'react';
import { renderIcon } from '../../components/icon/icon.render';
import {
  postComposerClass,
  postComposerEntryClass,
  postComposerErrorClass,
  postComposerFieldClass,
  postComposerSendClass,
} from './post-composer-class';

export type PostComposerRenderProps = {
  readonly draft: string;
  /** Names the field and is its placeholder: `Message # launch`. */
  readonly label: string;
  /** Why the last send failed, or null. */
  readonly error: string | null;
  /** Void action: keeps the typed draft. */
  readonly typeDraft: (draft: string) => void;
  /** Void action: sends the draft. Only called when there is text to send. */
  readonly send: () => void;
};

/**
 * A channel's post composer: plain text, Enter to send, Shift+Enter for a
 * new line. Mentions are whatever the text holds, sent as typed (DEC-7
 * defers the mention picker).
 */
export function renderPostComposer({ draft, label, error, typeDraft, send }: PostComposerRenderProps): ReactNode {
  const empty = draft.trim().length === 0;
  return (
    <form
      className={postComposerClass}
      onSubmit={(event) => {
        event.preventDefault();
        if (!empty) send();
      }}
    >
      <div className={postComposerEntryClass}>
        <textarea
          value={draft}
          rows={3}
          placeholder={label}
          aria-label={label}
          className={postComposerFieldClass}
          onChange={(event) => typeDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            // Safari confirms a composition with an Enter whose isComposing is
            // false; its keyCode is still 229.
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            if (event.key !== 'Enter' || event.shiftKey) return;
            event.preventDefault();
            if (!empty) send();
          }}
        />
        <button type="submit" aria-label="Send" title="Send" disabled={empty} className={postComposerSendClass}>
          {renderIcon({ name: 'send' })}
        </button>
      </div>
      {error === null ? null : (
        <p role="alert" className={postComposerErrorClass}>
          {error}
        </p>
      )}
    </form>
  );
}
